import { toKstDate } from './kis-common';
import type { CreateOrderRequest, Order } from './order-domain';

export interface RiskPosition { symbol: string; quantity: number; }
export interface RiskState { positions: RiskPosition[]; orders: Order[]; dailyLoss?: number; }
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
  | 'MAX_DAILY_LOSS';
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
  if (!Number.isFinite(dailyLoss) || dailyLoss >= config.maxDailyLoss) return blocked('MAX_DAILY_LOSS', { dailyLoss });
  return { allowed: true, reason: 'OK' };
}

export interface KillSwitchState { active: boolean; reason?: string; activatedAt?: string; updatedAt: string; }
const EMPTY_KILL_SWITCH: KillSwitchState = { active: false, updatedAt: new Date(0).toISOString() };

export class RiskStateStoreDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const current = (await this.state.storage.get<KillSwitchState>('kill-switch')) ?? EMPTY_KILL_SWITCH;
    if (request.method === 'GET') return Response.json(current, { headers: { 'cache-control': 'no-store' } });
    if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });

    const body = await request.json().catch(() => ({})) as { action?: 'activate' | 'deactivate'; reason?: string };
    if (body.action !== 'activate' && body.action !== 'deactivate') return Response.json({ error: 'INVALID_KILL_SWITCH_REQUEST' }, { status: 400 });

    const now = new Date().toISOString();
    const next: KillSwitchState = body.action === 'activate'
      ? { active: true, reason: body.reason?.trim().slice(0, 200) || 'manual', activatedAt: current.active ? current.activatedAt : now, updatedAt: now }
      : { active: false, updatedAt: now };
    await this.state.storage.put('kill-switch', next);
    return Response.json(next);
  }
}
