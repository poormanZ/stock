import type { Order } from './order-domain';
import type { ReconciliationState } from './reconciliation';

export interface InternalState extends ReconciliationState {
  updatedAt: string;
}

const EMPTY_STATE: InternalState = { positions: [], orders: [], updatedAt: new Date(0).toISOString() };

export class InternalStateStore {
  constructor(private readonly state: DurableObjectState) {}

  async get(): Promise<InternalState> {
    return (await this.state.storage.get<InternalState>('state')) ?? EMPTY_STATE;
  }

  async replace(next: ReconciliationState): Promise<InternalState> {
    const state: InternalState = { positions: next.positions, orders: next.orders, updatedAt: new Date().toISOString() };
    await this.state.storage.put('state', state);
    return state;
  }

  async applyOrder(order: Order): Promise<InternalState> {
    const current = await this.get();
    const orders = current.orders.filter((item) => item.brokerOrderId !== (order.brokerOrderId ?? ''));
    if (order.brokerOrderId) orders.push({ brokerOrderId: order.brokerOrderId, status: order.status, symbol: order.symbol, side: order.side, quantity: order.quantity, executedQuantity: order.executedQuantity });
    return this.replace({ positions: current.positions, orders });
  }
}

export class InternalStateStoreDO {
  private readonly store: InternalStateStore;
  constructor(state: DurableObjectState) { this.store = new InternalStateStore(state); }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET') return Response.json(await this.store.get(), { headers: { 'cache-control': 'no-store' } });
    if (request.method === 'PUT') {
      const body = await request.json() as ReconciliationState;
      if (!body || !Array.isArray(body.positions) || !Array.isArray(body.orders)) return Response.json({ error: 'INVALID_INTERNAL_STATE' }, { status: 400 });
      return Response.json(await this.store.replace(body));
    }
    return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  }
}
