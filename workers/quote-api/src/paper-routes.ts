import { createAccountAdapter, createOrderAdapter, createPaperOrderAdapter, createQuoteAdapter, getEnvironment, isAccountConfigured, type Env } from './env';
import { errorMessage, errorResponse, json, type RouteContext } from './http';
import { KISAccountConfigError, todayKst } from './kis-common';
import { KISHttpError } from './kis-http-client';
import { toPaperAcceptedOrder, type PaperOrderSubmission } from './kis-paper-order-adapter';
import { quoteReferenceTime } from './kis-quote-adapter';
import { reconcileWithKis } from './kis-reconciliation';
import { getMarketSession } from './market-session';
import { CANCELLABLE_STATUSES, createOrder, isValidOrderRequest, transitionOrder, type Order } from './order-domain';
import { checkNewOrderGate } from './order-gate';
import { resyncPaperOrders } from './paper-order-reconciliation';
import { checkRisk, DEFAULT_RISK_CONFIG } from './risk-manager';
import { applyInternalOrder, INTERNAL_STATE_UNAVAILABLE, readInternalState, readKillSwitch } from './state-clients';

/** PAPER 주문 경로 공통 선행 조건: PAPER 환경, 계좌 설정, (주문/취소는) 정규장 시간 */
function paperPrecheck(env: Env, origin: string, requireOpenMarket: boolean): Response | null {
  if (getEnvironment(env) !== 'PAPER') return json({ error: 'PAPER_ENVIRONMENT_REQUIRED' }, 409, origin);
  if (!isAccountConfigured(env)) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);
  if (requireOpenMarket) {
    const session = getMarketSession();
    if (!session.isOpen) {
      return json({ error: 'MARKET_SESSION_CLOSED', status: session.status, asOf: session.asOf, timeZone: session.timeZone }, 409, origin);
    }
  }
  return null;
}

function isInternalStateUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === INTERNAL_STATE_UNAVAILABLE;
}

export async function handlePaperOrder({ request, env, origin }: RouteContext): Promise<Response> {
  const blocked = paperPrecheck(env, origin, true);
  if (blocked) return blocked;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_PAPER_ORDER_REQUEST' }, 400, origin);
  const { request: orderRequest, referencePrice } = body as { request?: unknown; referencePrice?: unknown };
  if (!isValidOrderRequest(orderRequest)) return json({ error: 'INVALID_ORDER' }, 400, origin);
  if (typeof referencePrice !== 'number' || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return json({ error: 'INVALID_REFERENCE_PRICE' }, 400, origin);
  }

  const adapter = createPaperOrderAdapter(env);
  try {
    adapter.assertSubmittable(orderRequest);
  } catch (error) {
    if (error instanceof KISAccountConfigError) return json({ error: 'ACCOUNT_CONFIG_INVALID' }, 503, origin);
    return json({ error: 'INVALID_ORDER', reason: errorMessage(error) }, 400, origin);
  }

  let order: Order;
  try {
    const internalState = await readInternalState(env);
    const records = internalState.orderRecords ?? [];
    const existing = records.find((item) => item.clientOrderId === orderRequest.clientOrderId);
    if (existing) return json({ idempotent: true, order: existing }, 200, origin);

    const [reconciliation, quote, killSwitch] = await Promise.all([
      reconcileWithKis(env, internalState),
      createQuoteAdapter(env).getQuote(orderRequest.symbol),
      readKillSwitch(env),
    ]);
    const gate = checkNewOrderGate(orderRequest, reconciliation);
    if (!gate.allowed) return json({ error: gate.reason, reconciliation }, 409, origin);

    const now = new Date().toISOString();
    const risk = checkRisk({
      request: orderRequest,
      state: { positions: internalState.positions, orders: records },
      market: { referencePrice, quoteAsOf: quoteReferenceTime(quote), now },
      config: DEFAULT_RISK_CONFIG,
      killSwitchActive: killSwitch.active,
      reconciliationAllowed: reconciliation.canPlaceNewOrders,
      apiHealthy: true,
    });
    if (!risk.allowed) return json({ error: risk.reason, risk, reconciliation }, 409, origin);

    order = transitionOrder(createOrder(orderRequest, now), 'SUBMITTING');
    await applyInternalOrder(env, order);
  } catch (error) {
    return errorResponse(error, origin, 'RECONCILIATION');
  }

  let submission: PaperOrderSubmission;
  try {
    submission = await adapter.submit(orderRequest);
  } catch (error) {
    // 전송 결과를 확정할 수 없으므로 UNKNOWN으로 남기고 /paper/reconcile에서 복구한다
    console.error('PAPER order submission entered UNKNOWN', errorMessage(error));
    try {
      order = transitionOrder(order, 'UNKNOWN');
      await applyInternalOrder(env, order);
    } catch (persistError) {
      return errorResponse(persistError, origin, 'RECONCILIATION');
    }
    return json({ error: 'PAPER_ORDER_UNKNOWN', order }, 502, origin);
  }

  try {
    if (!submission.accepted) {
      order = transitionOrder(order, 'REJECTED');
      await applyInternalOrder(env, order);
      return json({ error: 'PAPER_ORDER_REJECTED', code: submission.messageCode, message: submission.message, order }, 409, origin);
    }
    order = toPaperAcceptedOrder(order, submission);
    await applyInternalOrder(env, order);
    return json({ order, messageCode: submission.messageCode, message: submission.message }, 200, origin);
  } catch (error) {
    console.error('PAPER order accepted by broker but internal state was not persisted', {
      brokerOrderId: submission.brokerOrderId,
      clientOrderId: orderRequest.clientOrderId,
      message: errorMessage(error),
    });
    return errorResponse(error, origin, 'RECONCILIATION');
  }
}

export async function handlePaperCancel({ request, env, origin }: RouteContext): Promise<Response> {
  const blocked = paperPrecheck(env, origin, true);
  if (blocked) return blocked;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_PAPER_CANCEL_REQUEST' }, 400, origin);
  const { id, clientOrderId } = body as { id?: unknown; clientOrderId?: unknown };
  if (typeof id !== 'string' && typeof clientOrderId !== 'string') return json({ error: 'ORDER_IDENTIFIER_REQUIRED' }, 400, origin);

  let order: Order | undefined;
  try {
    const internalState = await readInternalState(env);
    order = (internalState.orderRecords ?? []).find((item) => (typeof id === 'string' && item.id === id)
      || (typeof clientOrderId === 'string' && item.clientOrderId === clientOrderId));
    if (!order) return json({ error: 'ORDER_NOT_FOUND' }, 404, origin);
    if (!CANCELLABLE_STATUSES.has(order.status)) return json({ error: 'ORDER_NOT_CANCELLABLE', status: order.status, order }, 409, origin);

    const cancellation = await createPaperOrderAdapter(env).cancel(order);
    if (!cancellation.accepted) {
      return json({ error: 'PAPER_ORDER_CANCEL_REJECTED', code: cancellation.messageCode, message: cancellation.message, order }, 409, origin);
    }

    const canceledOrder = transitionOrder(order, 'CANCELED');
    await applyInternalOrder(env, canceledOrder);
    return json({ order: canceledOrder, messageCode: cancellation.messageCode, message: cancellation.message }, 200, origin);
  } catch (error) {
    if (order && error instanceof KISHttpError) {
      // 취소 전송 결과를 알 수 없으므로 UNKNOWN으로 남겨 resync 대상으로 만든다
      try {
        await applyInternalOrder(env, transitionOrder(order, 'UNKNOWN'));
      } catch (persistError) {
        return errorResponse(persistError, origin, 'RECONCILIATION');
      }
    }
    if (error instanceof KISHttpError || isInternalStateUnavailable(error)) return errorResponse(error, origin, 'RECONCILIATION');
    return json({ error: 'PAPER_ORDER_CANCEL_UNKNOWN', message: errorMessage(error) }, 502, origin);
  }
}

export async function handlePaperReconcile({ env, origin }: RouteContext): Promise<Response> {
  const blocked = paperPrecheck(env, origin, false);
  if (blocked) return blocked;

  try {
    const today = todayKst();
    const [internalState, account, brokerHistory] = await Promise.all([
      readInternalState(env),
      createAccountAdapter(env).getSnapshot(),
      createOrderAdapter(env).getOrderHistory(today, today),
    ]);

    const internalOrders = internalState.orderRecords ?? [];
    const result = resyncPaperOrders(internalOrders, brokerHistory.orders);
    for (const [index, order] of result.orders.entries()) {
      if (order !== internalOrders[index]) await applyInternalOrder(env, order);
    }

    return json({
      asOf: new Date().toISOString(),
      environment: getEnvironment(env),
      account,
      updated: result.updated,
      unresolved: result.unresolved,
      orders: result.orders,
    }, 200, origin);
  } catch (error) {
    return errorResponse(error, origin, 'RECONCILIATION');
  }
}
