import { describe, expect, it } from 'vitest';
import { createOrder, transitionOrder } from './order-domain';
import { resyncPaperOrders } from './paper-order-reconciliation';
import type { OrderRecord } from './kis-order-adapter';

const base = createOrder({ id: 'o1', clientOrderId: 'c1', symbol: '005930', side: 'buy', orderType: 'limit', quantity: 10, limitPrice: 70000 }, '2026-09-15T00:00:00.000Z');
const broker = (overrides: Partial<OrderRecord> = {}): OrderRecord => ({
  brokerOrderId: 'b1', brokerOrderOrgNo: 'org1', symbol: '005930', side: 'buy', orderType: 'limit', quantity: 10,
  executedQuantity: 0, averageExecutedPrice: 0, status: 'SUBMITTED', ...overrides,
});

describe('PAPER order reconciliation', () => {
  it('moves an accepted order to PARTIALLY_FILLED with broker execution data', () => {
    const accepted = transitionOrder({ ...base, brokerOrderId: 'b1', brokerOrderOrgNo: 'org1' }, 'ACCEPTED');
    const result = resyncPaperOrders([accepted], [broker({ executedQuantity: 4, averageExecutedPrice: 70100, status: 'PARTIALLY_FILLED' })]);
    expect(result.updated).toBe(1);
    expect(result.orders[0]).toMatchObject({ status: 'PARTIALLY_FILLED', executedQuantity: 4, averageExecutedPrice: 70100 });
  });

  it('moves a partially filled order to FILLED only when the full quantity executed', () => {
    const partial = transitionOrder({ ...base, brokerOrderId: 'b1', brokerOrderOrgNo: 'org1' }, 'PARTIALLY_FILLED', { executedQuantity: 4, averageExecutedPrice: 70100 });
    const result = resyncPaperOrders([partial], [broker({ executedQuantity: 10, averageExecutedPrice: 70200, status: 'FILLED' })]);
    expect(result.orders[0]).toMatchObject({ status: 'FILLED', executedQuantity: 10, averageExecutedPrice: 70200 });
  });

  it('resolves cancellation races through CANCEL_PENDING', () => {
    const accepted = transitionOrder({ ...base, brokerOrderId: 'b1', brokerOrderOrgNo: 'org1' }, 'ACCEPTED');
    const cancelPending = transitionOrder(accepted, 'CANCEL_PENDING');
    const partial = resyncPaperOrders([cancelPending], [broker({ executedQuantity: 4, averageExecutedPrice: 70100, status: 'PARTIALLY_FILLED' })]);
    expect(partial.orders[0]).toMatchObject({ status: 'PARTIALLY_FILLED', executedQuantity: 4 });
    const canceled = resyncPaperOrders([cancelPending], [broker({ status: 'CANCELED' })]);
    expect(canceled.orders[0].status).toBe('CANCELED');
  });

  it('recovers UNKNOWN through RECONCILING before applying the broker status', () => {
    const submitting = transitionOrder({ ...base, brokerOrderId: 'b1', brokerOrderOrgNo: 'org1' }, 'SUBMITTING');
    const unknown = transitionOrder(submitting, 'UNKNOWN');
    const result = resyncPaperOrders([unknown], [broker({ status: 'CANCELED' })]);
    expect(result.orders[0].status).toBe('CANCELED');
  });

  it('reports broker orders missing from the internal ledger as unresolved', () => {
    const result = resyncPaperOrders([], [broker({ brokerOrderId: 'external-1' })]);
    expect(result.unresolved).toEqual(['external-1']);
  });

  it('rejects impossible execution quantities', () => {
    const accepted = transitionOrder({ ...base, brokerOrderId: 'b1', brokerOrderOrgNo: 'org1' }, 'ACCEPTED');
    expect(() => resyncPaperOrders([accepted], [broker({ executedQuantity: 10, status: 'PARTIALLY_FILLED' })])).toThrow('INVALID_PARTIAL_FILL_QUANTITY');
    expect(() => resyncPaperOrders([accepted], [broker({ executedQuantity: 9, status: 'FILLED' })])).toThrow('FILLED_QUANTITY_MISMATCH');
  });

  it('is idempotent for an unchanged broker snapshot', () => {
    const accepted = transitionOrder({ ...base, brokerOrderId: 'b1', brokerOrderOrgNo: 'org1' }, 'ACCEPTED');
    const first = resyncPaperOrders([accepted], [broker({ executedQuantity: 4, averageExecutedPrice: 70100, status: 'PARTIALLY_FILLED' })]);
    const second = resyncPaperOrders(first.orders, [broker({ executedQuantity: 4, averageExecutedPrice: 70100, status: 'PARTIALLY_FILLED' })]);
    expect(first.updated).toBe(1);
    expect(second.updated).toBe(0);
  });
});
