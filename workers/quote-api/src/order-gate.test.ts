import { describe, expect, it } from 'vitest';
import { checkNewOrderGate } from './order-gate';

const request = {
  id: 'order-1',
  clientOrderId: 'client-1',
  symbol: '005930',
  side: 'buy' as const,
  orderType: 'limit' as const,
  quantity: 1,
  limitPrice: 100000,
};

const matched = { status: 'MATCHED' as const, canPlaceNewOrders: true, differences: [] };
const mismatched = { status: 'MISMATCHED' as const, canPlaceNewOrders: false, differences: [{ type: 'MISSING_INTERNAL_POSITION' as const, symbol: '005930', message: 'mismatch' }] };

describe('order gate', () => {
  it('allows a valid new order when reconciliation is matched', () => {
    expect(checkNewOrderGate(request, matched)).toEqual({ allowed: true, reason: 'OK', reconciliation: matched });
  });

  it('blocks every new order when reconciliation is mismatched', () => {
    const result = checkNewOrderGate(request, mismatched);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('RECONCILIATION_MISMATCH');
  });

  it('rejects malformed orders before they reach a broker adapter', () => {
    const result = checkNewOrderGate({ ...request, quantity: 0 }, matched);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('INVALID_ORDER');
  });
});
