import { describe, expect, it } from 'vitest';
import { checkExitRules, createStrategy, sizeEntry, sma, smaCrossoverStrategy, type Candle } from './strategy';

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({ date: `202601${String(i + 1).padStart(2, '0')}`, open: close, high: close, low: close, close, volume: 1000 }));
}

describe('strategy primitives', () => {
  it('computes simple moving averages and returns null during warmup', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1, 2], 3)).toBeNull();
  });

  it('emits buy on golden cross without position and sell on dead cross with position', () => {
    const strategy = smaCrossoverStrategy({ fast: 2, slow: 3 });
    // fast SMA 아래 → 위 돌파
    const up = candles([10, 9, 8, 8, 12]);
    expect(strategy.evaluate({ symbol: '005930', candles: up, position: null }).action).toBe('buy');
    expect(strategy.evaluate({ symbol: '005930', candles: up, position: { quantity: 1, averagePrice: 9 } }).action).toBe('hold');
    const down = candles([8, 9, 10, 10, 6]);
    expect(strategy.evaluate({ symbol: '005930', candles: down, position: { quantity: 1, averagePrice: 9 } }).action).toBe('sell');
    expect(strategy.evaluate({ symbol: '005930', candles: down, position: null }).action).toBe('hold');
    expect(strategy.evaluate({ symbol: '005930', candles: candles([1, 2]), position: null })).toEqual({ action: 'hold', reason: 'WARMUP' });
  });

  it('rejects invalid params and unknown ids', () => {
    expect(() => smaCrossoverStrategy({ fast: 20, slow: 5 })).toThrow('INVALID_STRATEGY_PARAMS');
    expect(() => createStrategy({ id: 'nope' })).toThrow('UNKNOWN_STRATEGY:nope');
    expect(createStrategy({ id: 'sma-crossover' }).params).toEqual({ fast: 5, slow: 20 });
  });

  it('applies stop loss and take profit before strategy signals', () => {
    const rules = { stopLossPct: 5, takeProfitPct: 10 };
    const position = { quantity: 10, averagePrice: 100 };
    expect(checkExitRules(position, 94, rules)?.reason).toMatch(/^STOP_LOSS/);
    expect(checkExitRules(position, 111, rules)?.reason).toMatch(/^TAKE_PROFIT/);
    expect(checkExitRules(position, 100, rules)).toBeNull();
    expect(checkExitRules(null, 50, rules)).toBeNull();
    expect(checkExitRules(position, 50, { stopLossPct: 0, takeProfitPct: 0 })).toBeNull();
  });

  it('sizes entries by the tightest of cash, amount, quantity and position limits', () => {
    const rules = { cashFraction: 0.5, maxOrderAmount: 1_000_000, maxOrderQuantity: 1000, maxPositionQuantity: 30 };
    expect(sizeEntry(10_000_000, 70_000, 0, rules)).toBe(14); // 1,000,000 / 70,000
    expect(sizeEntry(1_000_000, 70_000, 0, rules)).toBe(7); // 500,000 / 70,000
    expect(sizeEntry(10_000_000, 10_000, 25, rules)).toBe(5); // position cap
    expect(sizeEntry(0, 70_000, 0, rules)).toBe(0);
  });
});
