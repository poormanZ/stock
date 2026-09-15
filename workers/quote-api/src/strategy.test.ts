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
    const strategy = smaCrossoverStrategy({ fast: 2, slow: 3, trend: 0 });
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
    // trend를 생략하면 200일 필터가 기본으로 켜져 짧은 데이터에서는 워밍업 상태다
    expect(smaCrossoverStrategy({ fast: 2, slow: 3 }).evaluate({ symbol: 's', candles: candles([1, 2, 3, 4, 5]), position: null }).reason).toBe('WARMUP');
    expect(() => createStrategy({ id: 'nope' })).toThrow('UNKNOWN_STRATEGY:nope');
    expect(createStrategy({ id: 'sma-crossover' }).params).toEqual({ fast: 10, slow: 30, trend: 200 });
    expect(createStrategy({ id: 'sma-crossover' }).warmupBars).toBe(201);
  });

  it('applies stop loss and take profit before strategy signals', () => {
    const rules = { stopLossPct: 5, takeProfitPct: 10, trailingStopPct: 0 };
    const position = { quantity: 10, averagePrice: 100 };
    expect(checkExitRules(position, 94, rules)?.reason).toMatch(/^STOP_LOSS/);
    expect(checkExitRules(position, 111, rules)?.reason).toMatch(/^TAKE_PROFIT/);
    expect(checkExitRules(position, 100, rules)).toBeNull();
    expect(checkExitRules(null, 50, rules)).toBeNull();
    expect(checkExitRules(position, 50, { stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 0 })).toBeNull();
  });

  it('sizes entries by the tightest of cash, amount, quantity and position limits', () => {
    const rules = { cashFraction: 0.5, maxOrderAmount: 1_000_000, maxOrderQuantity: 1000, maxPositionQuantity: 30 };
    expect(sizeEntry(10_000_000, 70_000, 0, rules)).toBe(14); // 1,000,000 / 70,000
    expect(sizeEntry(1_000_000, 70_000, 0, rules)).toBe(7); // 500,000 / 70,000
    expect(sizeEntry(10_000_000, 10_000, 25, rules)).toBe(5); // position cap
    expect(sizeEntry(0, 70_000, 0, rules)).toBe(0);
  });
});

describe('additional strategies and exits', () => {
  const bars = (closes: number[], extra: Partial<Candle> = {}): Candle[] => closes.map((close, i) => ({ date: `2026${String(Math.floor(i / 28) + 1).padStart(2, '0')}${String((i % 28) + 1).padStart(2, '0')}`, open: close, high: close, low: close, close, volume: 1, ...extra }));

  it('sma-crossover with a trend filter refuses golden crosses below the long SMA', () => {
    const filtered = smaCrossoverStrategy({ fast: 2, slow: 3, trend: 5 });
    // 급락 후 반등: 2/3 골든크로스지만 5일선 아래
    const below = bars([30, 30, 10, 8, 14]);
    expect(filtered.evaluate({ symbol: 's', candles: below, position: null })).toMatchObject({ action: 'hold', reason: 'BELOW_TREND:5' });
    const above = bars([8, 8, 8, 7.9, 12]);
    expect(filtered.evaluate({ symbol: 's', candles: above, position: null })).toMatchObject({ action: 'buy', reason: 'SMA2>SMA3+T5' });
    expect(filtered.warmupBars).toBe(6);
  });

  it('momentum buys on positive lookback return above trend and sells when momentum turns negative', () => {
    const strategy = createStrategy({ id: 'momentum', params: { lookback: 3, trend: 4 } });
    expect(strategy.evaluate({ symbol: 's', candles: bars([10, 10, 10, 11, 12]), position: null }).action).toBe('buy');
    expect(strategy.evaluate({ symbol: 's', candles: bars([12, 12, 12, 11, 10]), position: null }).reason).toMatch(/^MOMENTUM_DOWN/);
    expect(strategy.evaluate({ symbol: 's', candles: bars([12, 12, 12, 11, 10]), position: { quantity: 1, averagePrice: 11 } }).action).toBe('sell');
    expect(strategy.evaluate({ symbol: 's', candles: bars([10, 10]), position: null }).reason).toBe('WARMUP');
  });

  it('volatility breakout enters at the breakout level and exits at the next open', () => {
    const strategy = createStrategy({ id: 'volatility-breakout', params: { k: 0.5 } });
    const prev: Candle = { date: '20260101', open: 100, high: 110, low: 90, close: 100, volume: 1 }; // range 20 → level = open + 10
    const breakout: Candle = { date: '20260102', open: 100, high: 115, low: 99, close: 112, volume: 1 };
    expect(strategy.evaluate({ symbol: 's', candles: [prev, breakout], position: null })).toEqual({ action: 'buy', reason: 'VB_BREAKOUT:k=0.5', price: 110 });
    // 일봉: 종가가 밀렸어도 고가가 닿았으면 그 순간 진입한 것으로 본다. 장중: 현재가가 돌파선 아래면 관망
    const faded: Candle = { ...breakout, close: 105 };
    expect(strategy.evaluate({ symbol: 's', candles: [prev, faded], position: null }).action).toBe('buy');
    expect(strategy.evaluate({ symbol: 's', candles: [prev, faded], position: null, intraday: true }).action).toBe('hold');
    expect(strategy.evaluate({ symbol: 's', candles: [prev, breakout], position: null, intraday: true }).action).toBe('buy');
    const nextDay: Candle = { date: '20260103', open: 113, high: 114, low: 111, close: 112, volume: 1 };
    expect(strategy.evaluate({ symbol: 's', candles: [prev, breakout, nextDay], position: { quantity: 1, averagePrice: 110, entryDate: '20260102' } })).toEqual({ action: 'sell', reason: 'VB_EXIT_NEXT_OPEN', price: 113 });
    expect(strategy.evaluate({ symbol: 's', candles: [prev, breakout], position: { quantity: 1, averagePrice: 110, entryDate: '20260102' } }).action).toBe('hold');
  });

  it('trailing stop sells after the peak close since entry drops by the configured percent', () => {
    const rules = { stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 5 };
    const candles = bars([100, 110, 120, 118, 113]);
    const position = { quantity: 1, averagePrice: 100, entryDate: candles[0].date };
    expect(checkExitRules(position, 113, rules, candles)?.reason).toMatch(/^TRAILING_STOP:-5\.83%/);
    expect(checkExitRules(position, 116, rules, candles)).toBeNull();
    expect(checkExitRules({ quantity: 1, averagePrice: 100 }, 50, rules, candles)).toBeNull();
  });
});
