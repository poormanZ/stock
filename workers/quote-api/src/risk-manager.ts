import type { CreateOrderRequest, Order } from './order-domain';

export interface RiskPosition { symbol: string; quantity: number; }
export interface RiskState { positions: RiskPosition[]; orders: Order[]; dailyLoss?: number; }
export interface RiskMarketData { referencePrice: number; quoteAsOf?: string; now?: string; }
export interface RiskConfig { maxOrderQuantity: number; maxOrderAmount: number; maxPositionQuantity: number; maxDailyOrders: number; maxDailyLoss: number; maxQuoteAgeMs: number; }
export interface RiskCheckInput { request: CreateOrderRequest; state: RiskState; market: RiskMarketData; config: RiskConfig; killSwitchActive: boolean; reconciliationAllowed: boolean; apiHealthy: boolean; }
export interface RiskCheckResult { allowed: boolean; reason: RiskReason; details?: Record<string, number | string | boolean>; }
export type RiskReason = 'OK' | 'KILL_SWITCH_ACTIVE' | 'RECONCILIATION_MISMATCH' | 'API_UNHEALTHY' | 'INVALID_MARKET_DATA' | 'STALE_QUOTE' | 'MAX_ORDER_QUANTITY' | 'MAX_ORDER_AMOUNT' | 'MAX_POSITION_QUANTITY' | 'MAX_DAILY_ORDERS' | 'MAX_DAILY_LOSS';

export const DEFAULT_RISK_CONFIG: RiskConfig = { maxOrderQuantity: 1000, maxOrderAmount: 1_000_000, maxPositionQuantity: 5000, maxDailyOrders: 20, maxDailyLoss: 100_000, maxQuoteAgeMs: 15_000 };

function assertConfig(config: RiskConfig): void { const values = Object.values(config); if (!values.every((v) => Number.isFinite(v) && v >= 0)) throw new Error('INVALID_RISK_CONFIG'); }
function dayKey(value: string): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(value)); }
function todayOrders(state: RiskState, now: string): Order[] { return state.orders.filter((o) => dayKey(o.createdAt) === dayKey(now)); }

export function checkRisk(input: RiskCheckInput): RiskCheckResult {
  assertConfig(input.config);
  if (input.killSwitchActive) return { allowed: false, reason: 'KILL_SWITCH_ACTIVE' };
  if (!input.reconciliationAllowed) return { allowed: false, reason: 'RECONCILIATION_MISMATCH' };
  if (!input.apiHealthy) return { allowed: false, reason: 'API_UNHEALTHY' };
  if (!Number.isFinite(input.market.referencePrice) || input.market.referencePrice <= 0) return { allowed: false, reason: 'INVALID_MARKET_DATA' };
  const now = input.market.now ?? new Date().toISOString();
  if (!input.market.quoteAsOf) return { allowed: false, reason: 'STALE_QUOTE' };
  const quoteAge = new Date(now).getTime() - new Date(input.market.quoteAsOf).getTime();
  if (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > input.config.maxQuoteAgeMs) return { allowed: false, reason: 'STALE_QUOTE', details: { quoteAgeMs: quoteAge } };
  if (input.request.quantity > input.config.maxOrderQuantity) return { allowed: false, reason: 'MAX_ORDER_QUANTITY', details: { quantity: input.request.quantity } };
  const orderPrice = input.request.orderType === 'limit' ? input.request.limitPrice! : input.market.referencePrice;
  const orderAmount = orderPrice * input.request.quantity;
  if (!Number.isFinite(orderAmount) || orderAmount > input.config.maxOrderAmount) return { allowed: false, reason: 'MAX_ORDER_AMOUNT', details: { orderAmount } };
  const position = input.state.positions.find((p) => p.symbol === input.request.symbol)?.quantity ?? 0;
  const nextPosition = input.request.side === 'buy' ? position + input.request.quantity : position - input.request.quantity;
  if (nextPosition > input.config.maxPositionQuantity || nextPosition < 0) return { allowed: false, reason: 'MAX_POSITION_QUANTITY', details: { nextPosition } };
  if (todayOrders(input.state, now).length >= input.config.maxDailyOrders) return { allowed: false, reason: 'MAX_DAILY_ORDERS' };
  const dailyLoss = input.state.dailyLoss ?? 0;
  if (!Number.isFinite(dailyLoss) || dailyLoss >= input.config.maxDailyLoss) return { allowed: false, reason: 'MAX_DAILY_LOSS', details: { dailyLoss } };
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
    const next: KillSwitchState = body.action === 'activate' ? { active: true, reason: body.reason?.trim().slice(0, 200) || 'manual', activatedAt: current.active ? current.activatedAt : now, updatedAt: now } : { active: false, updatedAt: now };
    await this.state.storage.put('kill-switch', next);
    return Response.json(next);
  }
}
