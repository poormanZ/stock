import { describe, expect, it } from 'vitest';
import { TRADING_RUN_HISTORY, TradingStateStoreDO, validateTradingConfig, type TradingRun, type TradingState } from './trading-state';

function stateStub(): DurableObjectState {
  let value: unknown;
  return { storage: { get: async () => value, put: async (_key: string, next: unknown) => { value = next; } } } as unknown as DurableObjectState;
}

const config = { mode: 'DRY_RUN', symbols: ['005930'], strategy: { id: 'sma-crossover' }, candleBars: 60 };
const post = (store: TradingStateStoreDO, body: unknown) => store.fetch(new Request('https://trading-state/', { method: 'POST', body: JSON.stringify(body) }));
const run = (id: string): TradingRun => ({ id, trigger: 'cron', mode: 'DRY_RUN', startedAt: '', finishedAt: '', status: 'OK', signals: [], orders: [] });

describe('trading state', () => {
  it('validates configs and fills defaults', () => {
    const valid = validateTradingConfig(config);
    expect(valid).toMatchObject({ mode: 'DRY_RUN', symbols: ['005930'], strategy: { id: 'sma-crossover', params: { fast: 5, slow: 20 } }, candleBars: 60 });
    expect(() => validateTradingConfig({ ...config, mode: 'LIVE' })).toThrow('INVALID_TRADING_MODE');
    expect(() => validateTradingConfig({ ...config, symbols: [] })).toThrow('INVALID_TRADING_SYMBOLS');
    expect(() => validateTradingConfig({ ...config, candleBars: 5 })).toThrow('INVALID_CANDLE_BARS');
    expect(() => validateTradingConfig({ ...config, candleBars: 30, strategy: { id: 'sma-crossover', params: { fast: 10, slow: 40 } } })).toThrow('CANDLE_BARS_BELOW_WARMUP');
  });

  it('walks STOPPED → READY → RUNNING → STOPPED and refuses start without config', async () => {
    const store = new TradingStateStoreDO(stateStub());
    expect((await post(store, { action: 'start' })).status).toBe(409);
    expect(((await (await post(store, { action: 'configure', config })).json()) as TradingState).status).toBe('READY');
    expect(((await (await post(store, { action: 'start' })).json()) as TradingState).status).toBe('RUNNING');
    expect((await post(store, { action: 'configure', config })).status).toBe(409);
    expect(((await (await post(store, { action: 'stop' })).json()) as TradingState).status).toBe('STOPPED');
  });

  it('grants a lease to one run at a time until it expires or is released', async () => {
    const store = new TradingStateStoreDO(stateStub());
    expect(await (await post(store, { action: 'acquire-lease', runId: 'a', ttlMs: 60_000 })).json()).toMatchObject({ acquired: true });
    expect(await (await post(store, { action: 'acquire-lease', runId: 'b', ttlMs: 60_000 })).json()).toMatchObject({ acquired: false });
    expect(await (await post(store, { action: 'release-lease', runId: 'b' })).json()).toEqual({ released: false });
    expect(await (await post(store, { action: 'release-lease', runId: 'a' })).json()).toEqual({ released: true });
    expect(await (await post(store, { action: 'acquire-lease', runId: 'b', ttlMs: 60_000 })).json()).toMatchObject({ acquired: true });
    // 만료된 lease는 다른 실행이 가져갈 수 있다 (장애 후 재개)
    const expired = new TradingStateStoreDO(stateStub());
    await post(expired, { action: 'acquire-lease', runId: 'stale', ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await (await post(expired, { action: 'acquire-lease', runId: 'fresh', ttlMs: 60_000 })).json()).toMatchObject({ acquired: true });
  });

  it('records runs with a bounded history and applies status transitions', async () => {
    const store = new TradingStateStoreDO(stateStub());
    await post(store, { action: 'start', config });
    for (let i = 0; i < TRADING_RUN_HISTORY + 3; i += 1) await post(store, { action: 'record-run', run: run(String(i)) });
    const state = (await (await store.fetch(new Request('https://trading-state/'))).json()) as TradingState;
    expect(state.runs).toHaveLength(TRADING_RUN_HISTORY);
    expect(state.lastRun?.id).toBe(String(TRADING_RUN_HISTORY + 2));
    const stopped = (await (await post(store, { action: 'record-run', run: run('x'), nextStatus: 'EMERGENCY_STOP', error: 'kill switch' })).json()) as TradingState;
    expect(stopped).toMatchObject({ status: 'EMERGENCY_STOP', error: 'kill switch' });
    expect((await post(store, { action: 'start' })).status).toBe(409);
  });
});
