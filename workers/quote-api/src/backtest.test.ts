import { describe, expect, it } from 'vitest';
import { runBacktest } from './backtest';
import { smaCrossoverStrategy, type Candle, type Strategy } from './strategy';

function series(closes: number[]): Candle[] {
  return closes.map((close, i) => ({ date: `2026${String(Math.floor(i / 28) + 1).padStart(2, '0')}${String((i % 28) + 1).padStart(2, '0')}`, open: close, high: close, low: close, close, volume: 1 }));
}

const zeroCost = { feeBps: 0, sellTaxBps: 0, slippageBps: 0 };
const exit = { stopLossPct: 0, takeProfitPct: 0 };
const sizing = { cashFraction: 1, maxOrderAmount: 10_000_000, maxOrderQuantity: 1000, maxPositionQuantity: 5000 };

/** 홀수 봉에 매수, 짝수 봉에 매도하는 결정적 전략 */
const alternating: Strategy = {
  id: 'alt',
  params: {},
  warmupBars: 1,
  evaluate({ candles, position }) {
    return candles.length % 2 === 1 ? (position ? { action: 'hold', reason: '' } : { action: 'buy', reason: 'odd' }) : (position ? { action: 'sell', reason: 'even' } : { action: 'hold', reason: '' });
  },
};

describe('runBacktest', () => {
  it('fills on the next bar open and reports round-trip trades and equity', () => {
    // 신호 봉 1(100) → 봉 2 시가 110에 매수, 신호 봉 2 → 봉 3 시가 121에 매도
    const candles = series([100, 110, 121, 121, 100]);
    const result = runBacktest({ symbol: '005930', candles, strategy: alternating, initialCash: 1_100, config: zeroCost, exit, sizing });
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]).toMatchObject({ entryPrice: 110, exitPrice: 121, quantity: 10, pnl: 110 });
    expect(result.trades[1]).toMatchObject({ entryPrice: 121, exitPrice: 100, pnl: -210 });
    expect(result.metrics).toMatchObject({ trades: 2, wins: 1, losses: 1, winRatePct: 50 });
    expect(result.metrics.profitFactor).toBeCloseTo(110 / 210, 5);
    expect(result.metrics.maxDrawdownPct).toBeGreaterThan(0);
    expect(result.openPosition).toBeNull();
  });

  it('charges fees and taxes through the DRY_RUN cost model', () => {
    const candles = series([100, 100, 100, 100]);
    const result = runBacktest({ symbol: '005930', candles, strategy: alternating, initialCash: 1_000, config: { feeBps: 100, sellTaxBps: 100, slippageBps: 0 }, exit, sizing });
    expect(result.metrics.totalFees).toBeGreaterThan(0);
    expect(result.metrics.totalTaxes).toBeGreaterThan(0);
    expect(result.metrics.finalEquity).toBeLessThan(1_000);
  });

  it('honours stop-loss exits and rejects insufficient history', () => {
    const buyOnce: Strategy = { id: 'once', params: {}, warmupBars: 1, evaluate: ({ candles, position }) => (candles.length === 1 && !position ? { action: 'buy', reason: 'first' } : { action: 'hold', reason: '' }) };
    const candles = series([100, 100, 90, 90, 90]);
    const result = runBacktest({ symbol: '005930', candles, strategy: buyOnce, initialCash: 1_000, config: zeroCost, exit: { stopLossPct: 5, takeProfitPct: 0 }, sizing });
    expect(result.trades[0]?.reason).toMatch(/^STOP_LOSS/);
    expect(() => runBacktest({ symbol: '005930', candles: series([1, 2]), strategy: smaCrossoverStrategy({ fast: 2, slow: 3 }), initialCash: 1_000, exit, sizing })).toThrow('INSUFFICIENT_CANDLES');
  });
});
