import { sendAlert } from './alerts';
import { createLiveOrderAdapter, getEnvironment, isAccountConfigured, type Env } from './env';
import { errorResponse, json, withCors, type RouteContext } from './http';
import { checkLiveTradingGate, LIVE_TRADING_CONFIRMATION, type LiveGateResult } from './live-trading-gate';
import { getMarketSession } from './market-session';
import { isValidOrderRequest } from './order-domain';
import { cancelCashOrder, placeCashOrder } from './paper-routes';
import { appendAudit, postKillSwitchCommand, readRiskState } from './state-clients';

/**
 * 실계좌 주문 경로. 모든 요청은 checkLiveTradingGate를 먼저 통과해야 하며,
 * 환경변수 LIVE_TRADING_ENABLED='true'와 PAPER_VERIFICATION_DATE가 없으면 항상 차단된다.
 */
async function evaluateGate(env: Env, confirmation: unknown): Promise<LiveGateResult> {
  const now = new Date();
  const risk = await readRiskState(env);
  return checkLiveTradingGate({
    liveTradingEnabled: env.LIVE_TRADING_ENABLED,
    paperVerificationDate: env.PAPER_VERIFICATION_DATE,
    environment: getEnvironment(env),
    accountConfigured: isAccountConfigured(env),
    killSwitchActive: risk.active,
    marketOpen: getMarketSession(now).isOpen,
    arm: risk.liveArm,
    confirmation,
    now,
  });
}

async function blockedResponse(env: Env, gate: LiveGateResult, origin: string, action: string): Promise<Response> {
  // 차단 자체도 감사 대상이다. 단, 기본 비활성 상태의 반복 호출은 소음이라 기록하지 않는다
  if (gate.reason !== 'LIVE_TRADING_DISABLED') {
    await appendAudit(env, { type: 'LIVE_GATE', mode: 'LIVE', message: `${action} blocked: ${gate.reason}`, details: gate.checks });
  }
  return json({ error: gate.reason, gate }, gate.reason === 'LIVE_TRADING_DISABLED' ? 403 : 409, origin);
}

export async function handleLiveStatus({ env, origin }: RouteContext): Promise<Response> {
  const gate = await evaluateGate(env, LIVE_TRADING_CONFIRMATION);
  return json({ enabled: gate.checks.enabled, wouldAllow: gate.allowed, reason: gate.reason, checks: gate.checks, confirmation: LIVE_TRADING_CONFIRMATION }, 200, origin);
}

/** 제한 시간 동안 실계좌 주문을 허용하는 명시적 활성화 절차. 확인 문구가 필요하다 */
export async function handleLiveArm({ request, env, origin }: RouteContext): Promise<Response> {
  if (env.LIVE_TRADING_ENABLED !== 'true') return json({ error: 'LIVE_TRADING_DISABLED' }, 403, origin);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_LIVE_ARM_REQUEST', confirmation: LIVE_TRADING_CONFIRMATION }, 400, origin);
  const response = await postKillSwitchCommand(env, { ...(body as object), action: 'arm' });
  if (response.ok) {
    const reason = (body as { reason?: unknown }).reason;
    await appendAudit(env, { type: 'LIVE_GATE', mode: 'LIVE', message: `live trading armed: ${typeof reason === 'string' ? reason : 'manual'}` });
    await sendAlert(env, { level: 'WARN', title: 'LIVE_TRADING_ARMED', message: 'live order path armed by operator' });
  }
  return withCors(response, origin);
}

export async function handleLiveDisarm({ env, origin }: RouteContext): Promise<Response> {
  const response = await postKillSwitchCommand(env, { action: 'disarm' });
  if (response.ok) await appendAudit(env, { type: 'LIVE_GATE', mode: 'LIVE', message: 'live trading disarmed' });
  return withCors(response, origin);
}

export async function handleLiveOrder({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_LIVE_ORDER_REQUEST' }, 400, origin);
  const { request: orderRequest, referencePrice, confirmation } = body as { request?: unknown; referencePrice?: unknown; confirmation?: unknown };

  const gate = await evaluateGate(env, confirmation);
  if (!gate.allowed) return blockedResponse(env, gate, origin, 'live order');

  if (!isValidOrderRequest(orderRequest)) return json({ error: 'INVALID_ORDER' }, 400, origin);
  if (typeof referencePrice !== 'number' || !Number.isFinite(referencePrice) || referencePrice <= 0) return json({ error: 'INVALID_REFERENCE_PRICE' }, 400, origin);

  await appendAudit(env, { type: 'LIVE_GATE', mode: 'LIVE', symbol: orderRequest.symbol, clientOrderId: orderRequest.clientOrderId, message: 'live gate passed for order' });
  const outcome = await placeCashOrder(env, { mode: 'LIVE', adapter: createLiveOrderAdapter(env), source: 'API' }, orderRequest, referencePrice);
  if (outcome.status === 'ERROR') return errorResponse(outcome.error, origin, 'RECONCILIATION');
  return json(outcome.body, outcome.status, origin);
}

export async function handleLiveCancel({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_LIVE_CANCEL_REQUEST' }, 400, origin);
  const { id, clientOrderId, confirmation } = body as { id?: unknown; clientOrderId?: unknown; confirmation?: unknown };

  const gate = await evaluateGate(env, confirmation);
  if (!gate.allowed) return blockedResponse(env, gate, origin, 'live cancel');
  if (typeof id !== 'string' && typeof clientOrderId !== 'string') return json({ error: 'ORDER_IDENTIFIER_REQUIRED' }, 400, origin);

  const outcome = await cancelCashOrder(env, { mode: 'LIVE', adapter: createLiveOrderAdapter(env) }, id, clientOrderId);
  if (outcome.status === 'ERROR') return errorResponse(outcome.error, origin, 'RECONCILIATION');
  return json(outcome.body, outcome.status, origin);
}
