import { sendAlert } from './alerts';
import { createAccountAdapter, createOrderAdapter, createPaperOrderAdapter, createQuoteAdapter, getEnvironment, isAccountConfigured, type Env } from './env';
import { toAcceptedOrder, type CashOrderSubmission, type KISCashOrderAdapter } from './kis-cash-order-adapter';
import { errorMessage, errorResponse, json, type RouteContext } from './http';
import { KISAccountConfigError, todayKst } from './kis-common';
import { KISHttpError } from './kis-http-client';
import { quoteReferenceTime } from './kis-quote-adapter';
import { reconcileWithKis } from './kis-reconciliation';
import { getMarketSession } from './market-session';
import { CANCELLABLE_STATUSES, createOrder, isValidOrderRequest, transitionOrder, type CreateOrderRequest, type Order } from './order-domain';
import { checkNewOrderGate } from './order-gate';
import { resyncPaperOrders, type PaperOrderResyncResult } from './paper-order-reconciliation';
import { dailyLossOf, type RealizedPnl } from './position-ledger';
import { checkRisk, DEFAULT_RISK_CONFIG } from './risk-manager';
import { appendAudit, applyInternalOrder, INTERNAL_STATE_UNAVAILABLE, readInternalState, readKillSwitch, syncInternalPositions } from './state-clients';

export type CashOrderMode = 'PAPER' | 'LIVE';
export type OrderSource = 'API' | 'SCHEDULER';

export type PaperOrderOutcome =
  | { status: 200; body: Record<string, unknown>; order?: Order }
  | { status: 400 | 409 | 502 | 503; body: Record<string, unknown>; order?: Order }
  | { status: 'ERROR'; error: unknown };
export type CashOrderOutcome = PaperOrderOutcome;

export interface CashOrderContext {
  mode: CashOrderMode;
  adapter: KISCashOrderAdapter;
  source: OrderSource;
}

/** PAPER 주문 경로 공통 선행 조건: PAPER 환경, 계좌 설정, (주문/취소는) 정규장 시간 */
export function paperPrecheck(env: Env, requireOpenMarket: boolean): Record<string, unknown> & { status: 409 | 503 } | null {
  if (getEnvironment(env) !== 'PAPER') return { status: 409, error: 'PAPER_ENVIRONMENT_REQUIRED' };
  if (!isAccountConfigured(env)) return { status: 503, error: 'ACCOUNT_NOT_CONFIGURED' };
  if (requireOpenMarket) {
    const session = getMarketSession();
    if (!session.isOpen) return { status: 409, error: 'MARKET_SESSION_CLOSED', sessionStatus: session.status, asOf: session.asOf, timeZone: session.timeZone };
  }
  return null;
}

function precheckResponse(blocked: NonNullable<ReturnType<typeof paperPrecheck>>, origin: string): Response {
  const { status, ...body } = blocked;
  return json(body, status, origin);
}

function isInternalStateUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === INTERNAL_STATE_UNAVAILABLE;
}

/**
 * 당일 실현손실 공급원. LIVE는 KIS 기간별매매손익(TTTC8715R)을, PAPER는 KIS가 해당 조회를 제공하지 않으므로
 * 체결 증분 원장(position-ledger)을 사용한다. 어느 쪽도 얻지 못하면 available=false로 Risk Manager가 차단한다.
 */
async function resolveDailyLoss(env: Env, mode: CashOrderMode, realized: RealizedPnl | undefined, now: string): Promise<{ dailyLoss: number; available: boolean; source: string }> {
  if (mode === 'PAPER') return { dailyLoss: dailyLossOf(realized, now), available: true, source: 'position-ledger' };
  try {
    const snapshot = await createAccountAdapter(env).getDailyLoss(todayKst());
    return { dailyLoss: snapshot.dailyLoss, available: true, source: snapshot.source };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('KIS_DAILY_LOSS_UNAVAILABLE')) return { dailyLoss: 0, available: false, source: 'unavailable' };
    throw error;
  }
}

/**
 * KIS 현금주문 전송(PAPER/LIVE 공통). 라우트와 자동 실행 엔진이 함께 사용한다.
 * 선행 조건(환경/계좌/장시간, LIVE 게이트)은 호출자가 확인한다.
 */
export async function placeCashOrder(env: Env, { mode, adapter, source }: CashOrderContext, orderRequest: CreateOrderRequest, referencePrice: number): Promise<CashOrderOutcome> {
  const auditBase = { mode, symbol: orderRequest.symbol, clientOrderId: orderRequest.clientOrderId };
  try {
    adapter.assertSubmittable(orderRequest);
  } catch (error) {
    if (error instanceof KISAccountConfigError) return { status: 503, body: { error: 'ACCOUNT_CONFIG_INVALID' } };
    return { status: 400, body: { error: 'INVALID_ORDER', reason: errorMessage(error) } };
  }

  let order: Order;
  try {
    const internalState = await readInternalState(env);
    const records = internalState.orderRecords ?? [];
    const existing = records.find((item) => item.clientOrderId === orderRequest.clientOrderId);
    if (existing) return { status: 200, body: { idempotent: true, order: existing }, order: existing };

    const now = new Date().toISOString();
    const [reconciliation, quote, killSwitch, dailyLoss] = await Promise.all([
      reconcileWithKis(env, internalState),
      createQuoteAdapter(env).getQuote(orderRequest.symbol),
      readKillSwitch(env),
      resolveDailyLoss(env, mode, internalState.realized, now),
    ]);
    const gate = checkNewOrderGate(orderRequest, reconciliation);
    if (!gate.allowed) {
      await appendAudit(env, { ...auditBase, type: 'RISK_BLOCKED', message: `${source} ${mode} order blocked by gate: ${gate.reason}`, details: { differences: reconciliation.differences.length } });
      return { status: 409, body: { error: gate.reason, reconciliation } };
    }

    const risk = checkRisk({
      request: orderRequest,
      state: { positions: internalState.positions, orders: records, dailyLoss: dailyLoss.dailyLoss, dailyLossAvailable: dailyLoss.available },
      market: { referencePrice, quoteAsOf: quoteReferenceTime(quote), now },
      config: DEFAULT_RISK_CONFIG,
      killSwitchActive: killSwitch.active,
      reconciliationAllowed: reconciliation.canPlaceNewOrders,
      apiHealthy: true,
    });
    if (!risk.allowed) {
      await appendAudit(env, { ...auditBase, type: 'RISK_BLOCKED', message: `${source} ${mode} order blocked: ${risk.reason}`, details: { ...risk.details } });
      return { status: 409, body: { error: risk.reason, risk, reconciliation } };
    }

    order = transitionOrder(createOrder(orderRequest, now), 'SUBMITTING');
    await applyInternalOrder(env, order);
    await appendAudit(env, { ...auditBase, type: 'ORDER_SUBMITTED', message: `${source} ${mode} ${orderRequest.side} ${orderRequest.symbol} x${orderRequest.quantity} ${orderRequest.orderType}${orderRequest.reason ? ` · ${orderRequest.reason}` : ''}`, details: { limitPrice: orderRequest.limitPrice, referencePrice } });
  } catch (error) {
    return { status: 'ERROR', error };
  }

  let submission: CashOrderSubmission;
  try {
    submission = await adapter.submit(orderRequest);
  } catch (error) {
    // 전송 결과를 확정할 수 없으므로 UNKNOWN으로 남기고 reconcile에서 복구한다
    console.error(`${mode} order submission entered UNKNOWN`, errorMessage(error));
    try {
      order = transitionOrder(order, 'UNKNOWN');
      await applyInternalOrder(env, order);
    } catch (persistError) {
      return { status: 'ERROR', error: persistError };
    }
    await appendAudit(env, { ...auditBase, type: 'ORDER_UNKNOWN', message: `${mode} submission result unknown: ${errorMessage(error)}` });
    await sendAlert(env, { level: mode === 'LIVE' ? 'CRITICAL' : 'ERROR', title: `${mode}_ORDER_UNKNOWN`, message: `${orderRequest.symbol} ${orderRequest.clientOrderId}: ${errorMessage(error)}` });
    return { status: 502, body: { error: `${mode}_ORDER_UNKNOWN`, order }, order };
  }

  try {
    if (!submission.accepted) {
      order = transitionOrder(order, 'REJECTED');
      await applyInternalOrder(env, order);
      await appendAudit(env, { ...auditBase, type: 'ORDER_REJECTED', message: `${mode} broker rejected: ${submission.messageCode ?? ''} ${submission.message ?? ''}`.trim() });
      return { status: 409, body: { error: `${mode}_ORDER_REJECTED`, code: submission.messageCode, message: submission.message, order }, order };
    }
    order = toAcceptedOrder(order, submission);
    await applyInternalOrder(env, order);
    await appendAudit(env, { ...auditBase, type: 'ORDER_ACCEPTED', brokerOrderId: order.brokerOrderId, message: `${mode} broker accepted ${submission.messageCode ?? ''}`.trim() });
    return { status: 200, body: { order, messageCode: submission.messageCode, message: submission.message }, order };
  } catch (error) {
    console.error(`${mode} order accepted by broker but internal state was not persisted`, {
      brokerOrderId: submission.brokerOrderId,
      clientOrderId: orderRequest.clientOrderId,
      message: errorMessage(error),
    });
    return { status: 'ERROR', error };
  }
}

export function placePaperOrder(env: Env, orderRequest: CreateOrderRequest, referencePrice: number, source: OrderSource = 'API'): Promise<PaperOrderOutcome> {
  return placeCashOrder(env, { mode: 'PAPER', adapter: createPaperOrderAdapter(env), source }, orderRequest, referencePrice);
}

export type CashCancelOutcome =
  | { status: 200 | 404 | 409 | 502; body: Record<string, unknown> }
  | { status: 'ERROR'; error: unknown };

/** 현금주문 취소(PAPER/LIVE 공통). 전송 결과가 불확실하면 UNKNOWN으로 남긴다 */
export async function cancelCashOrder(env: Env, { mode, adapter }: Omit<CashOrderContext, 'source'>, id: unknown, clientOrderId: unknown): Promise<CashCancelOutcome> {
  let order: Order | undefined;
  try {
    const internalState = await readInternalState(env);
    order = (internalState.orderRecords ?? []).find((item) => (typeof id === 'string' && item.id === id)
      || (typeof clientOrderId === 'string' && item.clientOrderId === clientOrderId));
    if (!order) return { status: 404, body: { error: 'ORDER_NOT_FOUND' } };
    if (!CANCELLABLE_STATUSES.has(order.status)) return { status: 409, body: { error: 'ORDER_NOT_CANCELLABLE', status: order.status, order } };

    const cancellation = await adapter.cancel(order);
    if (!cancellation.accepted) {
      return { status: 409, body: { error: `${mode}_ORDER_CANCEL_REJECTED`, code: cancellation.messageCode, message: cancellation.message, order } };
    }

    // 취소 접수 ≠ 취소 확정. 취소 전 체결과 경합할 수 있으므로 CANCEL_PENDING으로 두고 resync가 최종 상태를 확정한다
    const pendingOrder = transitionOrder(order, 'CANCEL_PENDING');
    await applyInternalOrder(env, pendingOrder);
    await appendAudit(env, { type: 'ORDER_CANCELED', mode, symbol: order.symbol, clientOrderId: order.clientOrderId, brokerOrderId: order.brokerOrderId, message: `${mode} cancel accepted (pending) ${cancellation.messageCode ?? ''}`.trim() });
    return { status: 200, body: { order: pendingOrder, messageCode: cancellation.messageCode, message: cancellation.message } };
  } catch (error) {
    if (order && error instanceof KISHttpError) {
      // 취소 전송 결과를 알 수 없으므로 UNKNOWN으로 남겨 resync 대상으로 만든다
      try {
        await applyInternalOrder(env, transitionOrder(order, 'UNKNOWN'));
      } catch (persistError) {
        return { status: 'ERROR', error: persistError };
      }
      await appendAudit(env, { type: 'ORDER_UNKNOWN', mode, symbol: order.symbol, clientOrderId: order.clientOrderId, brokerOrderId: order.brokerOrderId, message: `${mode} cancel result unknown: ${errorMessage(error)}` });
      await sendAlert(env, { level: mode === 'LIVE' ? 'CRITICAL' : 'ERROR', title: `${mode}_ORDER_CANCEL_UNKNOWN`, message: `${order.symbol} ${order.clientOrderId}: ${errorMessage(error)}` });
    }
    if (error instanceof KISHttpError || isInternalStateUnavailable(error)) return { status: 'ERROR', error };
    return { status: 502, body: { error: `${mode}_ORDER_CANCEL_UNKNOWN`, message: errorMessage(error) } };
  }
}

export async function handlePaperOrder({ request, env, origin }: RouteContext): Promise<Response> {
  const blocked = paperPrecheck(env, true);
  if (blocked) return precheckResponse(blocked, origin);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_PAPER_ORDER_REQUEST' }, 400, origin);
  const { request: orderRequest, referencePrice } = body as { request?: unknown; referencePrice?: unknown };
  if (!isValidOrderRequest(orderRequest)) return json({ error: 'INVALID_ORDER' }, 400, origin);
  if (typeof referencePrice !== 'number' || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return json({ error: 'INVALID_REFERENCE_PRICE' }, 400, origin);
  }

  const outcome = await placePaperOrder(env, orderRequest, referencePrice);
  if (outcome.status === 'ERROR') return errorResponse(outcome.error, origin, 'RECONCILIATION');
  return json(outcome.body, outcome.status, origin);
}

export async function handlePaperCancel({ request, env, origin }: RouteContext): Promise<Response> {
  const blocked = paperPrecheck(env, true);
  if (blocked) return precheckResponse(blocked, origin);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_PAPER_CANCEL_REQUEST' }, 400, origin);
  const { id, clientOrderId } = body as { id?: unknown; clientOrderId?: unknown };
  if (typeof id !== 'string' && typeof clientOrderId !== 'string') return json({ error: 'ORDER_IDENTIFIER_REQUIRED' }, 400, origin);

  const outcome = await cancelCashOrder(env, { mode: 'PAPER', adapter: createPaperOrderAdapter(env) }, id, clientOrderId);
  if (outcome.status === 'ERROR') return errorResponse(outcome.error, origin, 'RECONCILIATION');
  return json(outcome.body, outcome.status, origin);
}

export interface PaperResyncSummary extends PaperOrderResyncResult {
  account: Awaited<ReturnType<ReturnType<typeof createAccountAdapter>['getSnapshot']>>;
}

/** KIS 당일 주문내역으로 내부 주문 기록을 재동기화한다. 라우트와 스케줄러가 함께 사용한다 */
export async function resyncPaperOrdersWithKis(env: Env, source: 'API' | 'SCHEDULER' = 'API'): Promise<PaperResyncSummary> {
  const today = todayKst();
  const [internalState, account, brokerHistory] = await Promise.all([
    readInternalState(env),
    createAccountAdapter(env).getSnapshot(),
    createOrderAdapter(env).getOrderHistory(today, today),
  ]);

  const internalOrders = internalState.orderRecords ?? [];
  const result = resyncPaperOrders(internalOrders, brokerHistory.orders);
  for (const [index, order] of result.orders.entries()) {
    if (order === internalOrders[index]) continue;
    await applyInternalOrder(env, order);
    const type = order.status === 'FILLED' ? 'ORDER_FILLED' : order.status === 'PARTIALLY_FILLED' ? 'ORDER_PARTIAL_FILL' : order.status === 'CANCELED' ? 'ORDER_CANCELED' : order.status === 'REJECTED' ? 'ORDER_REJECTED' : 'RECONCILIATION';
    await appendAudit(env, { type, mode: 'PAPER', symbol: order.symbol, clientOrderId: order.clientOrderId, brokerOrderId: order.brokerOrderId, message: `${source} resync → ${order.status} ${order.executedQuantity}/${order.quantity}` });
  }
  await appendAudit(env, { type: 'RECONCILIATION', mode: 'PAPER', message: `${source} PAPER resync updated=${result.updated} unresolved=${result.unresolved.length}`, details: { unresolved: result.unresolved } });
  return { ...result, account };
}

/**
 * KIS 계좌 포지션 스냅샷을 내부 포지션 기준선으로 채택한다. 운영자가 명시적으로 호출하는 조치이며,
 * 이후 포지션은 체결 증분으로만 갱신되므로 이 시점 이후의 불일치는 reconciliation에서 드러난다.
 */
export async function handlePaperPositionSync({ env, origin }: RouteContext): Promise<Response> {
  const blocked = paperPrecheck(env, false);
  if (blocked) return precheckResponse(blocked, origin);
  try {
    const [account, previous] = await Promise.all([createAccountAdapter(env).getSnapshot(), readInternalState(env)]);
    // 평균단가를 함께 채택해야 이후 체결 증분 원장의 실현손익 계산이 가능하다
    const positions = account.positions.map(({ symbol, quantity, averagePrice }) => ({ symbol, quantity, averagePrice }));
    const state = await syncInternalPositions(env, positions);
    await appendAudit(env, { type: 'RECONCILIATION', mode: 'PAPER', message: `synced ${positions.length} KIS positions into internal state`, details: { symbols: positions.map((position) => position.symbol) } });
    return json({
      asOf: new Date().toISOString(),
      environment: getEnvironment(env),
      source: account.source,
      previousPositions: previous.positions,
      positions: state.positions,
      positionCount: state.positions.length,
      syncedAt: state.updatedAt,
    }, 200, origin);
  } catch (error) {
    return errorResponse(error, origin, 'POSITION_SYNC');
  }
}

export async function handlePaperReconcile({ env, origin }: RouteContext): Promise<Response> {
  const blocked = paperPrecheck(env, false);
  if (blocked) return precheckResponse(blocked, origin);

  try {
    const result = await resyncPaperOrdersWithKis(env);
    return json({
      asOf: new Date().toISOString(),
      environment: getEnvironment(env),
      account: result.account,
      updated: result.updated,
      unresolved: result.unresolved,
      orders: result.orders,
    }, 200, origin);
  } catch (error) {
    return errorResponse(error, origin, 'RECONCILIATION');
  }
}
