import type { Order } from './order-domain';
import type { ReconciliationState } from './reconciliation';

export interface InternalState extends ReconciliationState {
  updatedAt: string;
  orderRecords?: Order[];
}

const EMPTY_STATE: InternalState = { positions: [], orders: [], updatedAt: new Date(0).toISOString(), orderRecords: [] };

export class InternalStateStore {
  constructor(private readonly state: DurableObjectState) {}

  async get(): Promise<InternalState> {
    return (await this.state.storage.get<InternalState>('state')) ?? EMPTY_STATE;
  }

  async replace(next: ReconciliationState): Promise<InternalState> {
    const current = await this.get();
    const state: InternalState = {
      positions: next.positions,
      orders: next.orders,
      orderRecords: current.orderRecords ?? [],
      updatedAt: new Date().toISOString(),
    };
    await this.state.storage.put('state', state);
    return state;
  }

  async applyOrder(order: Order): Promise<InternalState> {
    const current = await this.get();
    const orders = current.orders.filter((item) => item.brokerOrderId !== (order.brokerOrderId ?? ''));
    if (order.brokerOrderId) {
      orders.push({
        brokerOrderId: order.brokerOrderId,
        clientOrderId: order.clientOrderId,
        status: order.status,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        executedQuantity: order.executedQuantity,
      });
    }
    const orderRecords = (current.orderRecords ?? [])
      .filter((item) => item.id !== order.id && item.clientOrderId !== order.clientOrderId);
    orderRecords.push(order);
    const state: InternalState = {
      positions: current.positions,
      orders,
      orderRecords,
      updatedAt: new Date().toISOString(),
    };
    await this.state.storage.put('state', state);
    return state;
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
    if (request.method === 'POST') {
      const body = await request.json().catch(() => null) as { action?: string; order?: Order } | null;
      if (body?.action !== 'apply-order' || !body.order) return Response.json({ error: 'INVALID_INTERNAL_STATE_ACTION' }, { status: 400 });
      return Response.json(await this.store.applyOrder(body.order));
    }
    return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  }
}
