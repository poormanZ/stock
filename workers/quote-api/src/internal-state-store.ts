import type { Order } from './order-domain';
import { applyFillDelta, type RealizedPnl } from './position-ledger';
import type { ReconciliationPosition, ReconciliationState } from './reconciliation';

export interface InternalState extends ReconciliationState {
  updatedAt: string;
  orderRecords?: Order[];
  realized?: RealizedPnl;
}

type InternalStateCommand =
  | { action: 'apply-order'; order: Order }
  | { action: 'sync-positions'; positions: ReconciliationPosition[] };

function isReconciliationPosition(value: unknown): value is ReconciliationPosition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ReconciliationPosition>;
  return typeof candidate.symbol === 'string' && /^\d{6}$/.test(candidate.symbol)
    && typeof candidate.quantity === 'number' && Number.isInteger(candidate.quantity) && candidate.quantity >= 0
    && (candidate.averagePrice === undefined || (typeof candidate.averagePrice === 'number' && Number.isFinite(candidate.averagePrice) && candidate.averagePrice >= 0));
}

/** 입력에 없는 필드를 만들지 않고 알려진 필드만 복사한다 */
function normalizePosition(position: ReconciliationPosition): ReconciliationPosition {
  return position.averagePrice === undefined
    ? { symbol: position.symbol, quantity: position.quantity }
    : { symbol: position.symbol, quantity: position.quantity, averagePrice: position.averagePrice };
}

function emptyState(): InternalState {
  return { positions: [], orders: [], orderRecords: [], updatedAt: new Date(0).toISOString() };
}

export class InternalStateStore {
  constructor(private readonly state: DurableObjectState) {}

  async get(): Promise<InternalState> {
    return (await this.state.storage.get<InternalState>('state')) ?? emptyState();
  }

  /** 포지션·요약 주문을 통째로 바꾼다. 주문 기록과 실현손익은 유지한다 */
  async replace(next: ReconciliationState): Promise<InternalState> {
    const current = await this.get();
    return this.persist({ ...current, positions: next.positions.map(normalizePosition), orders: next.orders });
  }

  /**
   * KIS 계좌 포지션 스냅샷을 내부 포지션 기준선으로 채택한다 (운영자의 명시적 조치).
   * 주문 요약·주문 기록·실현손익은 그대로 두므로 반복 호출해도 원장이 중복되지 않는다.
   */
  async syncPositions(positions: ReconciliationPosition[]): Promise<InternalState> {
    const current = await this.get();
    return this.persist({ ...current, positions: positions.filter((position) => position.quantity > 0).map(normalizePosition) });
  }

  /**
   * 주문 기록을 갱신하고, 이전 기록 대비 체결 증분을 포지션·실현손익에 반영한다.
   * 같은 기록을 다시 적용해도 증분이 0이라 상태가 바뀌지 않는다.
   */
  async applyOrder(order: Order): Promise<InternalState> {
    const current = await this.get();
    const records = current.orderRecords ?? [];
    const previous = records.find((item) => item.id === order.id || item.clientOrderId === order.clientOrderId);
    const ledger = applyFillDelta(
      { positions: current.positions.map((position) => ({ ...position, averagePrice: position.averagePrice ?? 0 })), realized: current.realized },
      previous,
      order,
      new Date(),
    );

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
    const orderRecords = records.filter((item) => item.id !== order.id && item.clientOrderId !== order.clientOrderId);
    orderRecords.push(order);
    return this.persist({ ...current, positions: ledger.positions, realized: ledger.realized, orders, orderRecords });
  }

  private async persist(state: InternalState): Promise<InternalState> {
    const next = { ...state, updatedAt: new Date().toISOString() };
    await this.state.storage.put('state', next);
    return next;
  }
}

export class InternalStateStoreDO {
  private readonly store: InternalStateStore;

  constructor(state: DurableObjectState) {
    this.store = new InternalStateStore(state);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET') return Response.json(await this.store.get(), { headers: { 'cache-control': 'no-store' } });
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => null) as ReconciliationState | null;
      if (!body || !Array.isArray(body.positions) || !Array.isArray(body.orders)) return Response.json({ error: 'INVALID_INTERNAL_STATE' }, { status: 400 });
      return Response.json(await this.store.replace(body));
    }
    if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });

    const body = await request.json().catch(() => null) as Partial<InternalStateCommand> | null;
    if (body?.action === 'apply-order' && body.order) return Response.json(await this.store.applyOrder(body.order));
    if (body?.action === 'sync-positions' && Array.isArray(body.positions) && body.positions.every(isReconciliationPosition)) {
      return Response.json(await this.store.syncPositions(body.positions));
    }
    return Response.json({ error: 'INVALID_INTERNAL_STATE_ACTION' }, { status: 400 });
  }
}
