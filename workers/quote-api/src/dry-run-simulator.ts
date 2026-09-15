import { assertOrderRequest, createOrder, isValidOrderRequest, type CreateOrderRequest, type Order } from './order-domain';

export interface DryRunPosition { symbol: string; quantity: number; averagePrice: number; }
export interface DryRunState { cash: number; positions: DryRunPosition[]; orders: Order[]; updatedAt: string; }
export interface DryRunConfig { feeBps: number; sellTaxBps: number; slippageBps: number; }
export interface DryRunExecution {
  order: Order;
  cash: number;
  positions: DryRunPosition[];
  grossAmount: number;
  fee: number;
  tax: number;
  executedPrice: number;
  executedQuantity: number;
  filled: boolean;
}

/** 라우트와 DO가 공유하는 주문 명령 본문 */
export interface DryRunOrderCommand {
  request: CreateOrderRequest;
  referencePrice: number;
  fillQuantity?: number;
  config?: DryRunConfig;
}

export const DEFAULT_DRY_RUN_CONFIG: DryRunConfig = { feeBps: 15, sellTaxBps: 20, slippageBps: 5 };
export const DEFAULT_DRY_RUN_CASH = 10_000_000;

function roundMoney(value: number): number {
  return Math.round(value);
}

function executionPrice(request: CreateOrderRequest, referencePrice: number, slippageBps: number): number {
  if (request.orderType === 'limit') return request.limitPrice!;
  const factor = 1 + (request.side === 'buy' ? 1 : -1) * slippageBps / 10_000;
  return referencePrice * factor;
}

function isValidConfig(config: unknown): config is DryRunConfig {
  if (!config || typeof config !== 'object') return false;
  const { feeBps, sellTaxBps, slippageBps } = config as Partial<DryRunConfig>;
  return [feeBps, sellTaxBps, slippageBps].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

export function createDryRunState(cash = DEFAULT_DRY_RUN_CASH): DryRunState {
  if (!Number.isFinite(cash) || cash < 0) throw new Error('INVALID_DRY_RUN_CASH');
  return { cash, positions: [], orders: [], updatedAt: new Date().toISOString() };
}

/** 상태를 직접 변경한다. 검증 실패 시 상태는 변경되지 않는다 */
export function simulateOrder(
  state: DryRunState,
  request: CreateOrderRequest,
  referencePrice: number,
  fillQuantity = request.quantity,
  config: DryRunConfig = DEFAULT_DRY_RUN_CONFIG,
): DryRunExecution {
  assertOrderRequest(request);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw new Error('INVALID_REFERENCE_PRICE');
  if (!Number.isInteger(fillQuantity) || fillQuantity < 0 || fillQuantity > request.quantity) throw new Error('INVALID_FILL_QUANTITY');
  if (!isValidConfig(config)) throw new Error('INVALID_DRY_RUN_CONFIG');

  const triggered = request.orderType === 'market'
    || (request.side === 'buy' ? referencePrice <= request.limitPrice! : referencePrice >= request.limitPrice!);
  const executedQuantity = triggered ? fillQuantity : 0;
  const executedPrice = executionPrice(request, referencePrice, config.slippageBps);
  const grossAmount = roundMoney(executedPrice * executedQuantity);
  const fee = roundMoney(grossAmount * config.feeBps / 10_000);
  const tax = request.side === 'sell' ? roundMoney(grossAmount * config.sellTaxBps / 10_000) : 0;
  const existing = state.positions.find((position) => position.symbol === request.symbol);
  const others = state.positions.filter((position) => position.symbol !== request.symbol);

  if (request.side === 'buy' && executedQuantity > 0) {
    const totalCost = grossAmount + fee;
    if (totalCost > state.cash) throw new Error('INSUFFICIENT_DRY_RUN_CASH');
    const oldQty = existing?.quantity ?? 0;
    const oldCost = oldQty * (existing?.averagePrice ?? 0);
    const quantity = oldQty + executedQuantity;
    state.positions = [...others, { symbol: request.symbol, quantity, averagePrice: (oldCost + grossAmount) / quantity }];
    state.cash = roundMoney(state.cash - totalCost);
  }
  if (request.side === 'sell' && executedQuantity > 0) {
    if (!existing || existing.quantity < executedQuantity) throw new Error('INSUFFICIENT_DRY_RUN_POSITION');
    const remaining = existing.quantity - executedQuantity;
    state.positions = remaining > 0 ? [...others, { ...existing, quantity: remaining }] : others;
    state.cash = roundMoney(state.cash + grossAmount - fee - tax);
  }

  const now = new Date().toISOString();
  const order: Order = {
    ...createOrder(request, now),
    executedQuantity,
    averageExecutedPrice: executedQuantity > 0 ? executedPrice : 0,
    status: executedQuantity === 0 ? 'ACCEPTED' : executedQuantity === request.quantity ? 'FILLED' : 'PARTIALLY_FILLED',
  };
  state.orders = [...state.orders, order];
  state.updatedAt = now;
  return { order, cash: state.cash, positions: state.positions, grossAmount, fee, tax, executedPrice, executedQuantity, filled: executedQuantity > 0 };
}

function dryRunJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

type DryRunCommand =
  | ({ action: 'order' } & Partial<DryRunOrderCommand>)
  | { action: 'reset'; initialCash?: number };

export class DryRunStateStoreDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const current = (await this.state.storage.get<DryRunState>('state')) ?? createDryRunState();
    if (request.method === 'GET') return dryRunJson(current);
    if (request.method !== 'POST') return dryRunJson({ error: 'METHOD_NOT_ALLOWED' }, 405);

    const body = await request.json().catch(() => null) as DryRunCommand | null;
    if (body?.action === 'reset') {
      try {
        const reset = createDryRunState(body.initialCash);
        await this.state.storage.put('state', reset);
        return dryRunJson(reset);
      } catch (error) {
        return dryRunJson({ error: error instanceof Error ? error.message : 'DRY_RUN_FAILED' }, 400);
      }
    }
    if (body?.action !== 'order' || !isValidOrderRequest(body.request) || typeof body.referencePrice !== 'number') {
      return dryRunJson({ error: 'INVALID_DRY_RUN_REQUEST' }, 400);
    }

    // 동일 clientOrderId 재전송은 새 주문을 만들지 않고 기존 결과를 돌려준다
    const existing = current.orders.find((order) => order.clientOrderId === body.request!.clientOrderId);
    if (existing) return dryRunJson({ mode: 'DRY_RUN', idempotent: true, order: existing, cash: current.cash, positions: current.positions });

    try {
      const result = simulateOrder(current, body.request, body.referencePrice, body.fillQuantity, body.config ?? DEFAULT_DRY_RUN_CONFIG);
      await this.state.storage.put('state', current);
      return dryRunJson({ mode: 'DRY_RUN', ...result });
    } catch (error) {
      return dryRunJson({ error: error instanceof Error ? error.message : 'DRY_RUN_FAILED' }, 400);
    }
  }
}
