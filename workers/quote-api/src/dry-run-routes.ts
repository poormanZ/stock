import type { DryRunExecution, DryRunOrderCommand } from './dry-run-simulator';
import { errorMessage, json, withCors, type RouteContext } from './http';
import { isValidOrderRequest } from './order-domain';
import { dailyLossOf } from './position-ledger';
import { checkRisk, DEFAULT_RISK_CONFIG } from './risk-manager';
import { appendAudit, fetchDryRunState, postDryRunCommand, readDryRunState, readKillSwitch } from './state-clients';
import type { Env } from './env';

export type DryRunOrderOutcome =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 409 | 503; body: Record<string, unknown> };

export async function handleDryRunState({ env, origin }: RouteContext): Promise<Response> {
  return withCors(await fetchDryRunState(env), origin);
}

/**
 * DRY_RUN은 KIS 계좌/시세/장운영시간에 의존하지 않는다. 요청의 referencePrice를 시뮬레이션 가격으로,
 * 현재 시각을 시세 기준 시각으로 사용하되 Risk Manager 한도와 Kill Switch는 그대로 적용한다.
 * 라우트와 자동 실행 엔진이 함께 사용한다.
 */
export async function placeDryRunOrder(env: Env, candidate: Partial<DryRunOrderCommand>, source: 'API' | 'SCHEDULER' = 'API'): Promise<DryRunOrderOutcome> {
  if (!isValidOrderRequest(candidate.request)) return { status: 400, body: { error: 'INVALID_ORDER' } };
  const referencePrice = candidate.referencePrice;
  if (typeof referencePrice !== 'number' || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return { status: 400, body: { error: 'INVALID_REFERENCE_PRICE' } };
  }
  const orderRequest = candidate.request;
  const auditBase = { mode: 'DRY_RUN' as const, symbol: orderRequest.symbol, clientOrderId: orderRequest.clientOrderId };

  try {
    const [killSwitch, dryState] = await Promise.all([readKillSwitch(env), readDryRunState(env)]);

    const existing = dryState.orders.find((order) => order.clientOrderId === orderRequest.clientOrderId);
    if (existing) return { status: 200, body: { mode: 'DRY_RUN', idempotent: true, order: existing, cash: dryState.cash, positions: dryState.positions } };

    const now = new Date().toISOString();
    const risk = checkRisk({
      request: orderRequest,
      state: { positions: dryState.positions, orders: dryState.orders, dailyLoss: dailyLossOf(dryState.realized, now) },
      market: { referencePrice, quoteAsOf: now, now },
      config: DEFAULT_RISK_CONFIG,
      killSwitchActive: killSwitch.active,
      reconciliationAllowed: true,
      apiHealthy: true,
    });
    if (!risk.allowed) {
      await appendAudit(env, { ...auditBase, type: 'RISK_BLOCKED', message: `${source} DRY_RUN order blocked: ${risk.reason}`, details: { ...risk.details, side: orderRequest.side, quantity: orderRequest.quantity } });
      return { status: 409, body: { error: risk.reason, risk } };
    }

    const response = await postDryRunCommand(env, { ...candidate, action: 'order' });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      await appendAudit(env, { ...auditBase, type: 'ORDER_REJECTED', message: `${source} DRY_RUN simulation rejected: ${String(body.error ?? response.status)}` });
      return { status: response.status === 400 ? 400 : 503, body };
    }
    const execution = body as unknown as Partial<DryRunExecution>;
    const status = execution.order?.status;
    await appendAudit(env, {
      ...auditBase,
      type: status === 'FILLED' ? 'ORDER_FILLED' : status === 'PARTIALLY_FILLED' ? 'ORDER_PARTIAL_FILL' : 'ORDER_ACCEPTED',
      message: `${source} DRY_RUN ${orderRequest.side} ${orderRequest.symbol} ${execution.executedQuantity ?? '?'}/${orderRequest.quantity} @ ${execution.executedPrice ?? '?'}`,
      details: { fee: execution.fee, tax: execution.tax, cash: execution.cash },
    });
    return { status: 200, body };
  } catch (error) {
    console.error('DRY_RUN order failed', errorMessage(error));
    return { status: 503, body: { error: 'DRY_RUN_UNAVAILABLE', message: errorMessage(error) } };
  }
}

export async function handleDryRunOrder({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_DRY_RUN_REQUEST' }, 400, origin);
  const outcome = await placeDryRunOrder(env, body as Partial<DryRunOrderCommand>);
  return json(outcome.body, outcome.status, origin);
}

export async function handleDryRunReset({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null);
  const command = body && typeof body === 'object' ? body : {};
  const response = await postDryRunCommand(env, { ...command, action: 'reset' });
  if (response.ok) await appendAudit(env, { type: 'RECONCILIATION', mode: 'DRY_RUN', message: 'DRY_RUN state reset' });
  return withCors(response, origin);
}
