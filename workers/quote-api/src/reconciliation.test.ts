import { describe, expect, it } from 'vitest';
import { reconcile } from './reconciliation';

describe('reconcile', () => {
  it('allows new orders only when positions and tracked order state match', () => {
    const state = {
      positions: [{ symbol: '005930', quantity: 2 }],
      orders: [{ brokerOrderId: '100', status: 'FILLED', symbol: '005930', side: 'buy' as const, quantity: 2, executedQuantity: 2 }],
    };
    expect(reconcile(state, state)).toEqual({ status: 'MATCHED', canPlaceNewOrders: true, differences: [] });
  });

  it('blocks new orders on a position mismatch', () => {
    const result = reconcile(
      { positions: [{ symbol: '005930', quantity: 3 }], orders: [] },
      { positions: [{ symbol: '005930', quantity: 2 }], orders: [] },
    );
    expect(result.status).toBe('MISMATCHED');
    expect(result.canPlaceNewOrders).toBe(false);
    expect(result.differences[0].type).toBe('POSITION_QUANTITY_MISMATCH');
  });

  it('blocks new orders when KIS has a position missing internally', () => {
    const result = reconcile(
      { positions: [{ symbol: '005930', quantity: 1 }], orders: [] },
      { positions: [], orders: [] },
    );
    expect(result.canPlaceNewOrders).toBe(false);
    expect(result.differences[0].type).toBe('MISSING_INTERNAL_POSITION');
  });

  it('blocks new orders when tracked order execution differs', () => {
    const result = reconcile(
      { positions: [], orders: [{ brokerOrderId: '100', status: 'FILLED', symbol: '005930', side: 'buy', quantity: 2, executedQuantity: 2 }] },
      { positions: [], orders: [{ brokerOrderId: '100', status: 'PARTIALLY_FILLED', symbol: '005930', side: 'buy', quantity: 2, executedQuantity: 1 }] },
    );
    expect(result.canPlaceNewOrders).toBe(false);
    expect(result.differences[0].type).toBe('ORDER_STATUS_MISMATCH');
  });
});
