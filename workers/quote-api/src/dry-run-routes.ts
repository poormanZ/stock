import type { DryRunOrderCommand } from './dry-run-simulator';
import { errorMessage, json, withCors, type RouteContext } from './http';
import { isValidOrderRequest } from './order-domain';
import { checkRisk, DEFAULT_RISK_CONFIG } from './risk-manager';
import { fetchDryRunState, postDryRunCommand, readDryRunState, readKillSwitch } from './state-clients';

export async function handleDryRunState({ env, origin }: RouteContext): Promise<Response> {
  return withCors(await fetchDryRunState(env), origin);
}

/**
 * DRY_RUN은 KIS 계좌/시세/장운영시간에 의존하지 않는다. 요청의 referencePrice를 시뮬레이션 가격으로,
 * 현재 시각을 시세 기준 시각으로 사용하되 Risk Manager 한도와 Kill Switch는 그대로 적용한다.
 */
export async function handleDryRunOrder({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_DRY_RUN_REQUEST' }, 400, origin);
  const candidate = body as Partial<DryRunOrderCommand>;
  if (!isValidOrderRequest(candidate.request)) return json({ error: 'INVALID_ORDER' }, 400, origin);
  const referencePrice = candidate.referencePrice;
  if (typeof referencePrice !== 'number' || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return json({ error: 'INVALID_REFERENCE_PRICE' }, 400, origin);
  }
  const orderRequest = candidate.request;

  try {
    const [killSwitch, dryState] = await Promise.all([readKillSwitch(env), readDryRunState(env)]);

    const existing = dryState.orders.find((order) => order.clientOrderId === orderRequest.clientOrderId);
    if (existing) return json({ mode: 'DRY_RUN', idempotent: true, order: existing, cash: dryState.cash, positions: dryState.positions }, 200, origin);

    const now = new Date().toISOString();
    const risk = checkRisk({
      request: orderRequest,
      state: dryState,
      market: { referencePrice, quoteAsOf: now, now },
      config: DEFAULT_RISK_CONFIG,
      killSwitchActive: killSwitch.active,
      reconciliationAllowed: true,
      apiHealthy: true,
    });
    if (!risk.allowed) return json({ error: risk.reason, risk }, 409, origin);

    return withCors(await postDryRunCommand(env, { ...candidate, action: 'order' }), origin);
  } catch (error) {
    console.error('DRY_RUN order failed', errorMessage(error));
    return json({ error: 'DRY_RUN_UNAVAILABLE', message: errorMessage(error) }, 503, origin);
  }
}

export async function handleDryRunReset({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null);
  const command = body && typeof body === 'object' ? body : {};
  return withCors(await postDryRunCommand(env, { ...command, action: 'reset' }), origin);
}
