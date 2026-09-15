import { toKstDate } from './kis-common';
import { LIVE_ARM_MAX_TTL_SECONDS, LIVE_TRADING_CONFIRMATION, type LiveArmState } from './live-trading-gate';
import type { CreateOrderRequest, Order } from './order-domain';

export interface RiskPosition { symbol: string; quantity: number; }
export interface RiskState { positions: RiskPosition[]; orders: Order[]; dailyLoss?: number; dailyLossAvailable?: boolean; }
export interface RiskMarketData { referencePrice: number; quoteAsOf?: string; now?: string; }
export interface RiskConfig {
  maxOrderQuantity: number;
  maxOrderAmount: number;
  maxPositionQuantity: number;
  maxDailyOrders: number;
  maxDailyLoss: number;
  maxQuoteAgeMs: number;
}
export interface RiskCheckInput {
  request: CreateOrderRequest;
  state: RiskState;
  market: RiskMarketData;
  config: RiskConfig;
  killSwitchActive: boolean;
  reconciliationAllowed: boolean;
  apiHealthy: boolean;
}
export type RiskReason =
  | 'OK'
  | 'KILL_SWITCH_ACTIVE'
  | 'RECONCILIATION_MISMATCH'
  | 'API_UNHEALTHY'
  | 'INVALID_MARKET_DATA'
  | 'STALE_QUOTE'
  | 'MAX_ORDER_QUANTITY'
  | 'MAX_ORDER_AMOUNT'
  | 'MAX_POSITION_QUANTITY'
  | 'MAX_DAILY_ORDERS'
  | 'MAX_DAILY_LOSS'
  | 'DAILY_LOSS_UNAVAILABLE';
export interface RiskCheckResult { allowed: boolean; reason: RiskReason; details?: Record<string, number | string | boolean>; }

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxOrderQuantity: 1000,
  maxOrderAmount: 1_000_000,
  maxPositionQuantity: 5000,
  maxDailyOrders: 20,
  maxDailyLoss: 100_000,
  maxQuoteAgeMs: 15_000,
};

function assertConfig(config: RiskConfig): void {
  if (!Object.values(config).every((value) => Number.isFinite(value) && value >= 0)) throw new Error('INVALID_RISK_CONFIG');
}

function countTodayOrders(orders: Order[], now: string): number {
  const today = toKstDate(now);
  return orders.filter((order) => toKstDate(order.createdAt) === today).length;
}

function blocked(reason: RiskReason, details?: RiskCheckResult['details']): RiskCheckResult {
  return details ? { allowed: false, reason, details } : { allowed: false, reason };
}

export function checkRisk(input: RiskCheckInput): RiskCheckResult {
  assertConfig(input.config);
  const { request, state, market, config } = input;

  if (input.killSwitchActive) return blocked('KILL_SWITCH_ACTIVE');
  if (!input.reconciliationAllowed) return blocked('RECONCILIATION_MISMATCH');
  if (!input.apiHealthy) return blocked('API_UNHEALTHY');
  if (!Number.isFinite(market.referencePrice) || market.referencePrice <= 0) return blocked('INVALID_MARKET_DATA');

  const now = market.now ?? new Date().toISOString();
  if (!market.quoteAsOf) return blocked('STALE_QUOTE');
  const quoteAge = new Date(now).getTime() - new Date(market.quoteAsOf).getTime();
  if (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > config.maxQuoteAgeMs) return blocked('STALE_QUOTE', { quoteAgeMs: quoteAge });

  if (request.quantity > config.maxOrderQuantity) return blocked('MAX_ORDER_QUANTITY', { quantity: request.quantity });
  const orderPrice = request.orderType === 'limit' ? request.limitPrice! : market.referencePrice;
  const orderAmount = orderPrice * request.quantity;
  if (!Number.isFinite(orderAmount) || orderAmount > config.maxOrderAmount) return blocked('MAX_ORDER_AMOUNT', { orderAmount });

  const position = state.positions.find((item) => item.symbol === request.symbol)?.quantity ?? 0;
  const nextPosition = request.side === 'buy' ? position + request.quantity : position - request.quantity;
  if (nextPosition > config.maxPositionQuantity || nextPosition < 0) return blocked('MAX_POSITION_QUANTITY', { nextPosition });

  if (countTodayOrders(state.orders, now) >= config.maxDailyOrders) return blocked('MAX_DAILY_ORDERS');
  const dailyLoss = state.dailyLoss ?? 0;
  if (state.dailyLossAvailable === false) return blocked('DAILY_LOSS_UNAVAILABLE');
  if (!Number.isFinite(dailyLoss) || dailyLoss >= config.maxDailyLoss) return blocked('MAX_DAILY_LOSS', { dailyLoss });
  return { allowed: true, reason: 'OK' };
}

export interface KillSwitchState { active: boolean; reason?: string; activatedAt?: string; updatedAt: string; }
/** GET /risk 응답. Kill Switch 상태에 실계좌 arm 상태를 덧붙인다 */
export interface RiskStateSnapshot extends KillSwitchState { liveArm: LiveArmState | null; }
const EMPTY_KILL_SWITCH: KillSwitchState = { active: false, updatedAt: new Date(0).toISOString() };

type RiskCommand =
  | { action: 'activate' | 'deactivate'; reason?: string }
  | { action: 'arm'; confirmation?: unknown; ttlSeconds?: unknown; reason?: unknown }
  | { action: 'disarm' };

export class RiskStateStoreDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const current = (await this.state.storage.get<KillSwitchState>('kill-switch')) ?? EMPTY_KILL_SWITCH;
    const arm = (await this.state.storage.get<LiveArmState>('live-arm')) ?? null;
    const snapshot = (): RiskStateSnapshot => ({ ...current, liveArm: arm && Date.parse(arm.armedUntil) > Date.now() ? arm : null });
    if (request.method === 'GET') return Response.json(snapshot(), { headers: { 'cache-control': 'no-store' } });
    if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });

    const body = await request.json().catch(() => ({})) as Partial<RiskCommand>;
    const now = new Date();

    if (body.action === 'activate' || body.action === 'deactivate') {
      const next: KillSwitchState = body.action === 'activate'
        ? { active: true, reason: (typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '') || 'manual', activatedAt: current.active ? current.activatedAt : now.toISOString(), updatedAt: now.toISOString() }
        : { active: false, updatedAt: now.toISOString() };
      await this.state.storage.put('kill-switch', next);
      // 긍급 정지 시 실계좌 arm도 함께 해제한다
      if (next.active) await this.state.storage.delete('live-arm');
      return Response.json({ ...next, liveArm: next.active ? null : snapshot().liveArm });
    }

    if (body.action === 'arm') {
      if (body.confirmation !== LIVE_TRADING_CONFIRMATION) return Response.json({ error: 'LIVE_CONFIRMATION_REQUIRED' }, { status: 400 });
      if (current.active) return Response.json({ error: 'KILL_SWITCH_ACTIVE' }, { status: 409 });
      const ttl = typeof body.ttlSeconds === 'number' && Number.isInteger(body.ttlSeconds) && body.ttlSeconds > 0 ? Math.min(body.ttlSeconds, LIVE_ARM_MAX_TTL_SECONDS) : LIVE_ARM_MAX_TTL_SECONDS;
      const next: LiveArmState = { armedAt: now.toISOString(), armedUntil: new Date(now.getTime() + ttl * 1000).toISOString(), reason: (typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '') || 'manual' };
      await this.state.storage.put('live-arm', next);
      return Response.json({ ...current, liveArm: next });
    }

    if (body.action === 'disarm') {
      await this.state.storage.delete('live-arm');
      return Response.json({ ...current, liveArm: null });
    }

    return Response.json({ error: 'INVALID_KILL_SWITCH_REQUEST' }, { status: 400 });
  }
}
