import { describe, expect, it } from 'vitest';
import { assertOrderRequest, canTransition, transitionOrder, type Order } from './order-domain';

const base: Order = {
  id: 'order-1', clientOrderId: 'client-1', symbol: '005930', side: 'buy', orderType: 'limit', quantity: 2,
  limitPrice: 70000, executedQuantity: 0, averageExecutedPrice: 0, status: 'CREATED',
  createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
};

describe('order domain', () => {
  it('allows the normal lifecycle', () => {
    expect(canTransition('CREATED', 'SUBMITTING')).toBe(true);
    expect(canTransition('SUBMITTED', 'ACCEPTED')).toBe(true);
    expect(canTransition('ACCEPTED', 'PARTIALLY_FILLED')).toBe(true);
    expect(canTransition('PARTIALLY_FILLED', 'FILLED')).toBe(true);
  });

  it('rejects unsafe terminal transitions', () => {
    expect(canTransition('FILLED', 'CANCELED')).toBe(false);
    expect(() => transitionOrder({ ...base, status: 'FILLED', executedQuantity: 2 }, 'SUBMITTED')).toThrow('INVALID_ORDER_TRANSITION');
  });

  it('requires full quantity for FILLED', () => {
    const accepted = { ...base, status: 'ACCEPTED' as const };
    expect(() => transitionOrder(accepted, 'FILLED', { executedQuantity: 1 })).toThrow('FILLED_QUANTITY_MISMATCH');
  });

  it('requires a strict partial quantity', () => {
    const accepted = { ...base, status: 'ACCEPTED' as const };
    expect(() => transitionOrder(accepted, 'PARTIALLY_FILLED', { executedQuantity: 0 })).toThrow('INVALID_PARTIAL_FILL_QUANTITY');
    expect(() => transitionOrder(accepted, 'PARTIALLY_FILLED', { executedQuantity: 1 })).not.toThrow();
  });

  it('validates order creation requests', () => {
    expect(() => assertOrderRequest({ id: '1', clientOrderId: 'c', symbol: '005930', side: 'buy', orderType: 'market', quantity: 1 })).not.toThrow();
    expect(() => assertOrderRequest({ id: '1', clientOrderId: 'c', symbol: '005930', side: 'buy', orderType: 'limit', quantity: 1 })).toThrow('INVALID_LIMIT_PRICE');
    expect(() => assertOrderRequest({ id: '1', clientOrderId: 'c', symbol: '005930', side: 'buy', orderType: 'market', quantity: 1, limitPrice: 70000 })).toThrow('MARKET_ORDER_PRICE_NOT_ALLOWED');
  });
});
