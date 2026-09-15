import { describe, expect, it } from 'vitest';
import { InternalStateStore } from './internal-state-store';
import type { Order } from './order-domain';

function stateStub(initial?: unknown): DurableObjectState {
  let value = initial;
  return { storage: { get: async () => value, put: async (_key: string, next: unknown) => { value = next; } } } as unknown as DurableObjectState;
}

const order: Order = {
  id: 'order-1',
  clientOrderId: 'client-1',
  brokerOrderId: 'broker-1',
  symbol: '005930',
  side: 'buy',
  orderType: 'limit',
  quantity: 1,
  limitPrice: 70000,
  executedQuantity: 0,
  averageExecutedPrice: 0,
  status: 'ACCEPTED',
  createdAt: '2026-09-14T12:00:00.000Z',
  updatedAt: '2026-09-14T12:00:01.000Z',
};

describe('InternalStateStore', () => {
  it('starts empty and persists replacement state', async () => {
    const store = new InternalStateStore(stateStub());
    expect((await store.get()).positions).toEqual([]);
    const saved = await store.replace({ positions: [{ symbol: '005930', quantity: 2 }], orders: [] });
    expect(saved.positions[0]).toEqual({ symbol: '005930', quantity: 2 });
    expect((await store.get()).positions[0].quantity).toBe(2);
  });

  it('recovers persisted state after a store instance is recreated', async () => {
    const storage = stateStub();
    const firstStore = new InternalStateStore(storage);
    await firstStore.applyOrder(order);
    await firstStore.syncPositions([{ symbol: '005930', quantity: 7 }]);

    const recoveredStore = new InternalStateStore(storage);
    const recovered = await recoveredStore.get();
    expect(recovered.positions).toEqual([{ symbol: '005930', quantity: 7 }]);
    expect(recovered.orders).toEqual([expect.objectContaining({ brokerOrderId: 'broker-1', clientOrderId: 'client-1' })]);
    expect(recovered.orderRecords).toEqual([order]);
  });

  it('syncs a broker position snapshot without deleting the order ledger', async () => {
    const store = new InternalStateStore(stateStub());
    await store.applyOrder(order);
    const saved = await store.syncPositions([{ symbol: '005930', quantity: 7 }, { symbol: '000660', quantity: 3 }]);
    expect(saved.positions).toEqual([{ symbol: '005930', quantity: 7 }, { symbol: '000660', quantity: 3 }]);
    expect(saved.orderRecords).toEqual([order]);
    expect(saved.orders).toEqual([expect.objectContaining({ brokerOrderId: 'broker-1' })]);
  });

  it('repeating the same position snapshot does not duplicate the order ledger', async () => {
    const store = new InternalStateStore(stateStub());
    await store.applyOrder(order);
    await store.syncPositions([{ symbol: '005930', quantity: 7 }]);
    const saved = await store.syncPositions([{ symbol: '005930', quantity: 7 }]);
    expect(saved.positions).toEqual([{ symbol: '005930', quantity: 7 }]);
    expect(saved.orders).toHaveLength(1);
    expect(saved.orderRecords).toHaveLength(1);
    expect(saved.orderRecords?.[0].clientOrderId).toBe('client-1');
  });

  it('persists orderRecords including clientOrderId for idempotency', async () => {
    const store = new InternalStateStore(stateStub());
    const saved = await store.applyOrder(order);
    expect(saved.orders[0]).toMatchObject({ brokerOrderId: 'broker-1', clientOrderId: 'client-1' });
    expect(saved.orderRecords).toEqual([order]);
  });

  it('replaces an existing clientOrderId instead of duplicating it', async () => {
    const store = new InternalStateStore(stateStub());
    await store.applyOrder(order);
    const updated = { ...order, status: 'FILLED' as const, executedQuantity: 1, updatedAt: '2026-09-14T12:00:02.000Z' };
    const saved = await store.applyOrder(updated);
    expect(saved.orderRecords).toHaveLength(1);
    expect(saved.orderRecords?.[0].status).toBe('FILLED');
  });
});

describe('InternalStateStore ledger and restart recovery', () => {
  it('updates positions and realized pnl from fill deltas applied through order records', async () => {
    const store = new InternalStateStore(stateStub());
    await store.applyOrder({ ...order, status: 'ACCEPTED', executedQuantity: 0 });
    const filled = await store.applyOrder({ ...order, status: 'FILLED', executedQuantity: 1, averageExecutedPrice: 70000, updatedAt: '2026-09-14T12:00:02.000Z' });
    expect(filled.positions).toEqual([{ symbol: '005930', quantity: 1, averagePrice: 70000 }]);

    const sell: Order = { ...order, id: 'order-2', clientOrderId: 'client-2', brokerOrderId: 'broker-2', side: 'sell', status: 'FILLED', executedQuantity: 1, averageExecutedPrice: 69000 };
    const sold = await store.applyOrder(sell);
    expect(sold.positions).toEqual([]);
    expect(sold.realized?.pnl).toBe(-1000);
    expect((await store.applyOrder(sell)).realized?.pnl).toBe(-1000);
  });

  it('keeps average prices from KIS snapshots and drops zero-quantity rows', async () => {
    const store = new InternalStateStore(stateStub());
    await store.applyOrder(order);
    const synced = await store.syncPositions([{ symbol: '000660', quantity: 3, averagePrice: 120000 }, { symbol: '005930', quantity: 0, averagePrice: 0 }]);
    expect(synced.positions).toEqual([{ symbol: '000660', quantity: 3, averagePrice: 120000 }]);
    expect(synced.orderRecords).toHaveLength(1);
  });

  it('recovers persisted state when a new store instance starts over the same storage', async () => {
    const shared = stateStub();
    await new InternalStateStore(shared).applyOrder({ ...order, status: 'FILLED', executedQuantity: 1, averageExecutedPrice: 70000 });
    const restarted = new InternalStateStore(shared);
    const state = await restarted.get();
    expect(state.orderRecords?.[0].status).toBe('FILLED');
    expect(state.positions[0]).toMatchObject({ symbol: '005930', quantity: 1 });
  });
});
