import { describe, expect, it, vi } from 'vitest';
import type { Env } from './env';
import type { Candle } from './strategy';
import { autoClientOrderId, runTradingCycle, type TradingDeps } from './trading-engine';
import type { TradingConfig, TradingState } from './trading-state';

const env = {} as Env;
const config: TradingConfig = {
  mode: 'DRY_RUN',
  symbols: ['005930'],
  strategy: { id: 'sma-crossover', params: { fast: 2, slow: 3 } },
  exit: { stopLossPct: 5, takeProfitPct: 10 },
  sizing: { cashFraction: 0.5, maxOrderAmount: 1_000_000, maxOrderQuantity: 1000, maxPositionQuantity: 5000 },
  candleBars: 30,
};

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({ date: `202609${String(i + 1).padStart(2, '0')}`, open: close, high: close, low: close, close, volume: 1 }));
}

function deps(overrides: Partial<TradingDeps> = {}, state: Partial<TradingState> = {}): TradingDeps & { recorded: Parameters<TradingDeps['recordRun']>[] } {
  const recorded: Parameters<TradingDeps['recordRun']>[] = [];
  return {
    recorded,
    now: () => new Date('2026-09-15T01:00:00.000Z'),
    readState: async () => ({ status: 'RUNNING', config, runs: [], updatedAt: '', ...state }),
    acquireLease: async () => true,
    releaseLease: vi.fn(async () => undefined),
    recordRun: async (...args) => { recorded.push(args); },
    readKillSwitch: async () => ({ active: false }),
    marketSession: () => ({ isOpen: true, status: 'OPEN', asOf: '', timeZone: 'Asia/Seoul' }),
    getCandles: async () => candles([10, 9, 8, 8, 12]), // 골든크로스 → buy
    getPrice: async () => 12,
    readPortfolio: async () => ({ cash: 1_000_000, positions: [] }),
    placeOrder: vi.fn(async () => ({ status: 200, body: { order: { status: 'FILLED' } } })),
    resyncPaper: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined),
    alert: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('runTradingCycle', () => {
  it('does nothing unless the engine is RUNNING', async () => {
    const d = deps({}, { status: 'READY' });
    expect(await runTradingCycle(env, 'cron', d)).toEqual({ ran: false, reason: 'NOT_RUNNING' });
    expect(d.placeOrder).not.toHaveBeenCalled();
  });

  it('places a sized market order on a buy signal with a daily idempotent client id', async () => {
    const d = deps();
    const result = await runTradingCycle(env, 'manual', d);
    expect(result.ran && result.run.status).toBe('OK');
    expect(d.placeOrder).toHaveBeenCalledTimes(1);
    const [mode, request, price] = (d.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(mode).toBe('DRY_RUN');
    expect(price).toBe(12);
    expect(request).toMatchObject({ symbol: '005930', side: 'buy', orderType: 'market', clientOrderId: autoClientOrderId('DRY_RUN', '20260915', '005930', 'buy'), reason: 'SMA2>SMA3' });
    expect(result.ran && result.run.orders[0]).toMatchObject({ reason: 'SMA2>SMA3', price: 12, result: 'FILLED' });
    // cash 1,000,000 × 0.5 / (12 × (1 + 20bp)) ≈ 41,583 → maxOrderAmount 1,000,000 / 12 = 83,333 → maxOrderQuantity 1000
    expect(request.quantity).toBe(1000);
    expect(d.releaseLease).toHaveBeenCalledTimes(1);
    expect(d.recorded[0][1]).toBeUndefined();
  });

  it('sells the whole position on a stop-loss regardless of the strategy signal', async () => {
    const d = deps({ getPrice: async () => 9, readPortfolio: async () => ({ cash: 0, positions: [{ symbol: '005930', quantity: 7, averagePrice: 10 }] }) });
    const result = await runTradingCycle(env, 'cron', d);
    expect(result.ran && result.run.signals[0].reason).toMatch(/^STOP_LOSS/);
    expect((d.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ side: 'sell', quantity: 7, reason: expect.stringMatching(/^STOP_LOSS/) });
  });

  it('moves to EMERGENCY_STOP without acquiring the lease when the kill switch is active', async () => {
    const acquireLease = vi.fn(async () => true);
    const d = deps({ readKillSwitch: async () => ({ active: true }), acquireLease });
    const result = await runTradingCycle(env, 'cron', d);
    expect(result.ran && result.run.reason).toBe('KILL_SWITCH_ACTIVE');
    expect(d.recorded[0][1]).toBe('EMERGENCY_STOP');
    expect(acquireLease).not.toHaveBeenCalled();
    expect(d.alert).toHaveBeenCalledWith(expect.objectContaining({ level: 'CRITICAL' }));
  });

  it('skips when another run holds the lease and when the PAPER market is closed', async () => {
    expect(await runTradingCycle(env, 'cron', deps({ acquireLease: async () => false }))).toEqual({ ran: false, reason: 'LEASE_HELD' });
    const closed = deps({ marketSession: () => ({ isOpen: false, status: 'WEEKEND', asOf: '', timeZone: 'Asia/Seoul' }) }, { config: { ...config, mode: 'PAPER' } });
    const result = await runTradingCycle(env, 'cron', closed);
    expect(result.ran && result.run.reason).toBe('MARKET_CLOSED');
    expect(closed.placeOrder).not.toHaveBeenCalled();
    expect(closed.resyncPaper).not.toHaveBeenCalled();
  });

  it('resyncs PAPER orders before evaluating and stops with ERROR on data failures', async () => {
    const d = deps({ getCandles: async () => { throw new Error('KIS down'); } }, { config: { ...config, mode: 'PAPER' } });
    const result = await runTradingCycle(env, 'cron', d);
    expect(d.resyncPaper).toHaveBeenCalledTimes(1);
    expect(result.ran && result.run.error).toEqual({ source: 'DATA', message: 'KIS down' });
    expect(d.recorded[0][1]).toBe('ERROR');
    expect(d.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('classifies order transport failures and does not continue to other symbols', async () => {
    const d = deps({ placeOrder: vi.fn(async () => { throw new Error('boom'); }) }, { config: { ...config, symbols: ['005930', '000660'] } });
    const result = await runTradingCycle(env, 'cron', d);
    expect(result.ran && result.run.error?.source).toBe('ORDER');
    expect(result.ran && result.run.orders).toEqual([expect.objectContaining({ symbol: '005930', status: 'ERROR' })]);
    expect(d.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('treats an idempotent response as already placed and holds with insufficient candles', async () => {
    const d = deps({ placeOrder: vi.fn(async () => ({ status: 200, body: { idempotent: true } })) }, { config: { ...config, symbols: ['005930', '000660'] } });
    const result = await runTradingCycle(env, 'cron', d);
    expect(result.ran && result.run.orders.every((order) => order.result === 'ALREADY_PLACED')).toBe(true);
    const short = deps({ getCandles: async () => candles([1, 2]) });
    const held = await runTradingCycle(env, 'cron', short);
    expect(held.ran && held.run.signals[0].reason).toBe('INSUFFICIENT_CANDLES');
    expect(short.placeOrder).not.toHaveBeenCalled();
  });
});
