import { describe, expect, it } from 'vitest';
import type { Order } from './order-domain';
import { addRealized, applyFillDelta, dailyLossOf, isLedgerPosition, type Ledger } from './position-ledger';

const empty = (): Ledger => ({ positions: [] });

const now = '2026-09-15T01:00:00.000Z'; // KST 2026-09-15 10:00
const base: Order = { id: 'o1', clientOrderId: 'c1', symbol: '005930', side: 'buy', orderType: 'market', quantity: 10, executedQuantity: 0, averageExecutedPrice: 0, status: 'ACCEPTED', createdAt: now, updatedAt: now };

describe('position ledger', () => {
  it('builds a position from incremental buy fills with a weighted average', () => {
    let ledger = applyFillDelta(empty(), undefined, { ...base, executedQuantity: 4, averageExecutedPrice: 100, status: 'PARTIALLY_FILLED' }, now);
    expect(ledger.positions).toEqual([{ symbol: '005930', quantity: 4, averagePrice: 100 }]);
    // 4주@100 → 10주 평균 106: 추가 6주는 110에 체결
    ledger = applyFillDelta(ledger, { ...base, executedQuantity: 4, averageExecutedPrice: 100 }, { ...base, executedQuantity: 10, averageExecutedPrice: 106, status: 'FILLED' }, now);
    expect(ledger.positions[0].quantity).toBe(10);
    expect(ledger.positions[0].averagePrice).toBeCloseTo(106, 6);
  });

  it('is idempotent when the same record is applied twice', () => {
    const filled = { ...base, executedQuantity: 10, averageExecutedPrice: 100, status: 'FILLED' as const };
    const once = applyFillDelta(empty(), undefined, filled, now);
    const twice = applyFillDelta(once, filled, filled, now);
    expect(twice.positions).toEqual(once.positions);
  });

  it('realizes P/L on sells, clamps at zero position and rolls the daily counter', () => {
    const start: Ledger = { positions: [{ symbol: '005930', quantity: 10, averagePrice: 100 }] };
    const sell: Order = { ...base, id: 's1', clientOrderId: 's1', side: 'sell', quantity: 10, executedQuantity: 10, averageExecutedPrice: 90, status: 'FILLED' };
    const after = applyFillDelta(start, undefined, sell, now);
    expect(after.positions).toEqual([]);
    expect(after.realized).toEqual({ date: '20260915', pnl: -100 });
    expect(dailyLossOf(after.realized, now)).toBe(100);
    expect(dailyLossOf(after.realized, '2026-09-16T01:00:00.000Z')).toBe(0);

    const over = applyFillDelta({ positions: [{ symbol: '005930', quantity: 3, averagePrice: 100 }] } as Ledger, undefined, sell, now);
    expect(over.positions).toEqual([]);
    expect(over.realized?.pnl).toBe(-30);
  });

  it('accumulates realized pnl and validates positions', () => {
    const ledger = addRealized(addRealized(empty(), -50, now), 20, now);
    expect(ledger.realized).toEqual({ date: '20260915', pnl: -30 });
    expect(addRealized({ ...empty(), realized: { date: '20260914', pnl: -500 } }, -1, now).realized).toEqual({ date: '20260915', pnl: -1 });
    expect(isLedgerPosition({ symbol: '005930', quantity: 1, averagePrice: 100 })).toBe(true);
    expect(isLedgerPosition({ symbol: '5930', quantity: 1, averagePrice: 100 })).toBe(false);
    expect(isLedgerPosition({ symbol: '005930', quantity: 1.5, averagePrice: 100 })).toBe(false);
  });
});
