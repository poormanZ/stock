import { describe, expect, it } from 'vitest';
import { resyncPaperOrders } from './paper-order-reconciliation';
import type { Order } from './order-domain';
import type { OrderRecord } from './kis-order-adapter';

const internal: Order = {
  id: 'order-1',
  clientOrderId: 'client-1',
  brokerOrderId: '12345',
  symbol: '005930',
  side: 'buy',
  orderType: 'limit',
  quantity: 10,
  limitPrice: 70000,
  executedQuantity: 0,
  averageExecutedPrice: 0,
  status: 'ACCEPTED',
  createdAt: '2026-09-14T09:00:00.000Z',
  updatedAt: '2026-09-14T09:01:00.000Z',
};

const broker: OrderRecord = {
  brokerOrderId: '12345',
  originalOrderId: '',
  orderDate: '20260914',
  symbol: '005930',
  name: '삼성전자',
  side: 'buy',
  orderType: 'limit',
  quantity: 10,
  orderPrice: 70000,
  executedQuantity: 10,
  averageExecutedPrice: 70150,
  status: 'FILLED',
  orderTime: '101500',
};

describe('resyncPaperOrders', () => {
  it('resyncs a partial fill with executed quantity and average price', () => {
    const result = resyncPaperOrders([internal], [{ ...broker, executedQuantity: 4, averageExecutedPrice: 70100, status: 'PARTIALLY_FILLED' }]);
    expect(result.updated).toBe(1);
    expect(result.orders[0]).toMatchObject({
      brokerOrderId: '12345',
      status: 'PARTIALLY_FILLED',
      executedQuantity: 4,
      averageExecutedPrice: 70100,
    });
    expect(result.unresolved).toEqual([]);
  });

  it('resyncs a filled order from KIS history', () => {
    const result = resyncPaperOrders([internal], [broker]);
    expect(result.updated).toBe(1);
    expect(result.orders[0]).toMatchObject({
      brokerOrderId: '12345',
      status: 'FILLED',
      executedQuantity: 10,
      averageExecutedPrice: 70150,
    });
    expect(result.unresolved).toEqual([]);
  });

  it('resyncs a canceled order without changing executed quantity', () => {
    const result = resyncPaperOrders([internal], [{ ...broker, status: 'CANCELED', executedQuantity: 0, averageExecutedPrice: 0 }]);
    expect(result.updated).toBe(1);
    expect(result.orders[0]).toMatchObject({
      brokerOrderId: '12345',
      status: 'CANCELED',
      executedQuantity: 0,
      averageExecutedPrice: 0,
    });
  });

  it('does not mutate orders that are absent from KIS history and reports KIS-only orders', () => {
    const result = resyncPaperOrders([internal], [{ ...broker, brokerOrderId: '99999' }]);
    expect(result.updated).toBe(0);
    expect(result.orders[0]).toEqual(internal);
    expect(result.unresolved).toEqual(['99999']);
  });

  it('is idempotent when the same broker snapshot is reconciled twice', () => {
    const first = resyncPaperOrders([internal], [{ ...broker, executedQuantity: 4, averageExecutedPrice: 70100, status: 'PARTIALLY_FILLED' }]);
    const second = resyncPaperOrders(first.orders, [{ ...broker, executedQuantity: 4, averageExecutedPrice: 70100, status: 'PARTIALLY_FILLED' }]);
    expect(first.updated).toBe(1);
    expect(second.updated).toBe(0);
    expect(second.orders[0]).toMatchObject({ status: 'PARTIALLY_FILLED', executedQuantity: 4, averageExecutedPrice: 70100 });
  });

  it('supports the normal partial-fill to filled progression', () => {
    const partial = resyncPaperOrders([internal], [{ ...broker, executedQuantity: 4, averageExecutedPrice: 70100, status: 'PARTIALLY_FILLED' }]);
    const filled = resyncPaperOrders(partial.orders, [broker]);
    expect(filled.updated).toBe(1);
    expect(filled.orders[0]).toMatchObject({ status: 'FILLED', executedQuantity: 10, averageExecutedPrice: 70150 });
  });

  it('rejects a filled broker snapshot whose executed quantity is incomplete', () => {
    expect(() => resyncPaperOrders([internal], [{ ...broker, executedQuantity: 9 }])).toThrow('FILLED_QUANTITY_MISMATCH');
  });

  it('rejects an invalid partial-fill quantity', () => {
    expect(() => resyncPaperOrders([internal], [{ ...broker, status: 'PARTIALLY_FILLED', executedQuantity: 10 }])).toThrow('INVALID_PARTIAL_FILL_QUANTITY');
  });
});
