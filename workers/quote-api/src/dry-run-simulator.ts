import { assertOrderRequest, type CreateOrderRequest, type Order } from './order-domain';

export interface DryRunPosition { symbol: string; quantity: number; averagePrice: number; }
export interface DryRunState { cash: number; positions: DryRunPosition[]; orders: Order[]; updatedAt: string; }
export interface DryRunConfig { feeBps: number; sellTaxBps: number; slippageBps: number; }
export interface DryRunExecution { order: Order; cash: number; positions: DryRunPosition[]; grossAmount: number; fee: number; tax: number; executedPrice: number; executedQuantity: number; filled: boolean; }

export const DEFAULT_DRY_RUN_CONFIG: DryRunConfig = { feeBps: 15, sellTaxBps: 20, slippageBps: 5 };
export const DEFAULT_DRY_RUN_CASH = 10_000_000;

function roundMoney(value: number): number { return Math.round(value); }
function executionPrice(request: CreateOrderRequest, referencePrice: number, slippageBps: number): number {
  if (request.orderType === 'limit') return request.limitPrice!;
  const factor = 1 + (request.side === 'buy' ? 1 : -1) * slippageBps / 10_000;
  return referencePrice * factor;
}

export function createDryRunState(cash = DEFAULT_DRY_RUN_CASH): DryRunState {
  if (!Number.isFinite(cash) || cash < 0) throw new Error('INVALID_DRY_RUN_CASH');
  return { cash, positions: [], orders: [], updatedAt: new Date().toISOString() };
}

export function simulateOrder(state: DryRunState, request: CreateOrderRequest, referencePrice: number, fillQuantity = request.quantity, config: DryRunConfig = DEFAULT_DRY_RUN_CONFIG): DryRunExecution {
  assertOrderRequest(request);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw new Error('INVALID_REFERENCE_PRICE');
  if (!Number.isInteger(fillQuantity) || fillQuantity < 0 || fillQuantity > request.quantity) throw new Error('INVALID_FILL_QUANTITY');
  if (![config.feeBps, config.sellTaxBps, config.slippageBps].every((value) => Number.isFinite(value) && value >= 0)) throw new Error('INVALID_DRY_RUN_CONFIG');
  const triggered = request.orderType === 'market' || (request.side === 'buy' ? referencePrice <= request.limitPrice! : referencePrice >= request.limitPrice!);
  const executedQuantity = triggered ? fillQuantity : 0;
  const executedPrice = executionPrice(request, referencePrice, config.slippageBps);
  const grossAmount = roundMoney(executedPrice * executedQuantity);
  const fee = roundMoney(grossAmount * config.feeBps / 10_000);
  const tax = request.side === 'sell' ? roundMoney(grossAmount * config.sellTaxBps / 10_000) : 0;
  const existing = state.positions.find((position) => position.symbol === request.symbol);
  if (request.side === 'buy' && executedQuantity > 0) {
    const totalCost = grossAmount + fee;
    if (totalCost > state.cash) throw new Error('INSUFFICIENT_DRY_RUN_CASH');
    const oldQty = existing?.quantity ?? 0;
    const oldCost = oldQty * (existing?.averagePrice ?? 0);
    const positions = state.positions.filter((position) => position.symbol !== request.symbol);
    positions.push({ symbol: request.symbol, quantity: oldQty + executedQuantity, averagePrice: (oldCost + grossAmount) / (oldQty + executedQuantity) });
    state.cash = roundMoney(state.cash - totalCost);
    state.positions = positions;
  }
  if (request.side === 'sell' && executedQuantity > 0) {
    if (!existing || existing.quantity < executedQuantity) throw new Error('INSUFFICIENT_DRY_RUN_POSITION');
    const remaining = existing.quantity - executedQuantity;
    const positions = state.positions.filter((position) => position.symbol !== request.symbol);
    if (remaining > 0) positions.push({ ...existing, quantity: remaining });
    state.cash = roundMoney(state.cash + grossAmount - fee - tax);
    state.positions = positions;
  }
  const now = new Date().toISOString();
  const order: Order = { ...request, executedQuantity, averageExecutedPrice: executedQuantity > 0 ? executedPrice : 0, status: executedQuantity === 0 ? 'ACCEPTED' : executedQuantity === request.quantity ? 'FILLED' : 'PARTIALLY_FILLED', createdAt: now, updatedAt: now };
  state.orders = [...state.orders, order];
  state.updatedAt = now;
  return { order, cash: state.cash, positions: state.positions, grossAmount, fee, tax, executedPrice, executedQuantity, filled: executedQuantity > 0 };
}

export class DryRunStateStoreDO {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const current = (await this.state.storage.get<DryRunState>('state')) ?? createDryRunState();
    if (request.method === 'GET') return Response.json(current, { headers: { 'cache-control': 'no-store' } });
    if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
    const body = await request.json() as { action?: 'reset' | 'order'; request?: CreateOrderRequest; referencePrice?: number; fillQuantity?: number; config?: DryRunConfig; initialCash?: number };
    if (body.action === 'reset') { const reset = createDryRunState(body.initialCash); await this.state.storage.put('state', reset); return Response.json(reset); }
    if (body.action !== 'order' || !body.request || !Number.isFinite(body.referencePrice)) return Response.json({ error: 'INVALID_DRY_RUN_REQUEST' }, { status: 400 });
    try {
      const result = simulateOrder(current, body.request, body.referencePrice!, body.fillQuantity, body.config ?? DEFAULT_DRY_RUN_CONFIG);
      await this.state.storage.put('state', current);
      return Response.json({ mode: 'DRY_RUN', ...result });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'DRY_RUN_FAILED' }, { status: 400 }); }
  }
}
