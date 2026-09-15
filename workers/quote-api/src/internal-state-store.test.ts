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
