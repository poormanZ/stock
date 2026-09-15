import { describe, expect, it, vi } from 'vitest';
import app from './index';
import type { Env } from './env';
import type { DryRunState } from './dry-run-simulator';
import type { Order } from './order-domain';

const ORIGIN = 'https://pages.test';

function namespace(handler: (request: Request) => Response | Promise<Response>) {
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input, init))));
  const ns = { idFromName: () => 'primary', get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
  return { ns, fetch };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_KEY: 'k',
    APP_SECRET: 's',
    ACCOUNT_CANO: '12345678',
    ACCOUNT_PRODUCT_CODE: '01',
    KIS_TOKEN_CACHE: {} as KVNamespace,
    KIS_TOKEN_BROKER: namespace(() => Response.json({})).ns,
    INTERNAL_STATE_STORE: namespace(() => Response.json({ positions: [], orders: [], orderRecords: [] })).ns,
    DRY_RUN_STATE_STORE: namespace(() => Response.json(emptyDryRun())).ns,
    RISK_STATE_STORE: namespace(() => Response.json({ active: false, updatedAt: '1970-01-01T00:00:00.000Z' })).ns,
    AUDIT_LOG_STORE: namespace(() => Response.json({ ok: true })).ns,
    TRADING_STATE_STORE: namespace(() => Response.json({ status: 'STOPPED', config: null, runs: [], updatedAt: '1970-01-01T00:00:00.000Z' })).ns,
    KIS_ENVIRONMENT: 'LIVE',
    ALLOWED_ORIGIN: ORIGIN,
    ...overrides,
  };
}

function emptyDryRun(): DryRunState {
  return { cash: 10_000_000, positions: [], orders: [], updatedAt: '2026-09-15T00:00:00.000Z' };
}

const orderRequest = { id: 'o1', clientOrderId: 'DRY-1', symbol: '005930', side: 'buy', orderType: 'market', quantity: 1 };

function post(path: string, body: unknown): Request {
  return new Request(`https://worker.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('worker router', () => {
  it('answers preflight with an empty 204 and the configured origin', async () => {
    const response = await app.fetch(new Request('https://worker.test/dry-run/orders', { method: 'OPTIONS' }), makeEnv());
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await response.text()).toBe('');
  });

  it('distinguishes unknown paths from unsupported methods', async () => {
    expect((await app.fetch(new Request('https://worker.test/nope'), makeEnv())).status).toBe(404);
    expect((await app.fetch(new Request('https://worker.test/quote', { method: 'POST' }), makeEnv())).status).toBe(405);
    expect((await app.fetch(new Request('https://worker.test/dry-run/orders'), makeEnv())).status).toBe(405);
  });

  it('adds CORS headers to Durable Object passthrough responses', async () => {
    const env = makeEnv();
    for (const path of ['/risk', '/dry-run']) {
      const response = await app.fetch(new Request(`https://worker.test${path}`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('returns a CORS-enabled 500 when a handler throws unexpectedly', async () => {
    const audit = namespace(() => Response.json({ ok: true }));
    const env = makeEnv({ RISK_STATE_STORE: namespace(() => { throw new Error('boom'); }).ns, AUDIT_LOG_STORE: audit.ns });
    const response = await app.fetch(new Request('https://worker.test/risk'), env);
    expect(response.status).toBe(500);
    expect(audit.fetch).toHaveBeenCalledTimes(1);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await response.json()).toEqual({ error: 'INTERNAL_ERROR' });
  });

  it('validates DRY_RUN order bodies before touching state', async () => {
    const env = makeEnv();
    expect((await app.fetch(post('/dry-run/orders', { request: { ...orderRequest, side: 'hold' }, referencePrice: 1000 }), env)).status).toBe(400);
    expect(await (await app.fetch(post('/dry-run/orders', { request: orderRequest, referencePrice: 0 }), env)).json()).toEqual({ error: 'INVALID_REFERENCE_PRICE' });
  });

  it('blocks DRY_RUN orders while the kill switch is active', async () => {
    const dryRun = namespace(() => Response.json(emptyDryRun()));
    const env = makeEnv({
      RISK_STATE_STORE: namespace(() => Response.json({ active: true, updatedAt: '2026-09-15T00:00:00.000Z' })).ns,
      DRY_RUN_STATE_STORE: dryRun.ns,
    });
    const response = await app.fetch(post('/dry-run/orders', { request: orderRequest, referencePrice: 70_000 }), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'KILL_SWITCH_ACTIVE' });
    expect(dryRun.fetch.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('returns the existing DRY_RUN order for a repeated clientOrderId without re-simulating', async () => {
    const existing: Order = { ...orderRequest, side: 'buy', orderType: 'market', executedQuantity: 1, averageExecutedPrice: 70_035, status: 'FILLED', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' };
    const dryRun = namespace(() => Response.json({ ...emptyDryRun(), orders: [existing] }));
    const response = await app.fetch(post('/dry-run/orders', { request: orderRequest, referencePrice: 70_000 }), makeEnv({ DRY_RUN_STATE_STORE: dryRun.ns }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'DRY_RUN', idempotent: true, order: { id: 'o1', status: 'FILLED' } });
    expect(dryRun.fetch).toHaveBeenCalledTimes(1);
  });

  it('forwards an allowed DRY_RUN order to the simulator with CORS headers', async () => {
    const dryRun = namespace(async (request) => {
      if (request.method === 'GET') return Response.json(emptyDryRun());
      const body = await request.json() as { action: string; request: { clientOrderId: string } };
      return Response.json({ mode: 'DRY_RUN', received: body.action, clientOrderId: body.request.clientOrderId });
    });
    const response = await app.fetch(post('/dry-run/orders', { request: orderRequest, referencePrice: 70_000 }), makeEnv({ DRY_RUN_STATE_STORE: dryRun.ns }));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await response.json()).toEqual({ mode: 'DRY_RUN', received: 'order', clientOrderId: 'DRY-1' });
  });

  it('refuses PAPER order routes outside the PAPER environment before any KIS call', async () => {
    const internal = namespace(() => Response.json({}));
    const env = makeEnv({ KIS_ENVIRONMENT: 'LIVE', INTERNAL_STATE_STORE: internal.ns });
    for (const path of ['/paper/orders', '/paper/orders/cancel', '/paper/reconcile']) {
      const response = await app.fetch(post(path, { request: orderRequest, referencePrice: 70_000 }), env);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'PAPER_ENVIRONMENT_REQUIRED' });
    }
    expect(internal.fetch).not.toHaveBeenCalled();
  });
});

describe('live trading routes', () => {
  it('reports the gate as disabled and refuses orders/arming without the flag, before any KIS call', async () => {
    const internal = namespace(() => Response.json({}));
    const env = makeEnv({ INTERNAL_STATE_STORE: internal.ns, RISK_STATE_STORE: namespace(() => Response.json({ active: false, updatedAt: '', liveArm: null })).ns });
    const status = await app.fetch(new Request('https://worker.test/live/status'), env);
    expect(await status.json()).toMatchObject({ enabled: false, wouldAllow: false, reason: 'LIVE_TRADING_DISABLED' });
    for (const path of ['/live/orders', '/live/orders/cancel', '/live/arm']) {
      const response = await app.fetch(post(path, { request: orderRequest, referencePrice: 70_000, confirmation: 'I_UNDERSTAND_LIVE_TRADING' }), env);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'LIVE_TRADING_DISABLED' });
    }
    expect(internal.fetch).not.toHaveBeenCalled();
  });

  it('still blocks with the flag on when paper verification or arming is missing', async () => {
    const env = makeEnv({ LIVE_TRADING_ENABLED: 'true', RISK_STATE_STORE: namespace(() => Response.json({ active: false, updatedAt: '', liveArm: null })).ns });
    const response = await app.fetch(post('/live/orders', { request: orderRequest, referencePrice: 70_000, confirmation: 'I_UNDERSTAND_LIVE_TRADING' }), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'PAPER_VERIFICATION_REQUIRED' });
  });
});

describe('trading routes', () => {
  it('exposes engine status with CORS and rejects invalid configs before touching the store', async () => {
    const trading = namespace(() => Response.json({ status: 'STOPPED', config: null, runs: [], updatedAt: '' }));
    const env = makeEnv({ TRADING_STATE_STORE: trading.ns });
    const status = await app.fetch(new Request('https://worker.test/trading/status'), env);
    expect(status.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const bad = await app.fetch(post('/trading/configure', { config: { mode: 'LIVE', symbols: ['005930'], strategy: { id: 'sma-crossover' } } }), env);
    expect(bad.status).toBe(400);
    const paperInLive = await app.fetch(post('/trading/configure', { config: { mode: 'PAPER', symbols: ['005930'], strategy: { id: 'sma-crossover' } } }), env);
    expect(await paperInLive.json()).toMatchObject({ reason: 'PAPER_ENVIRONMENT_REQUIRED' });
    expect(trading.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    const manual = await app.fetch(post('/trading/run', {}), env);
    expect(manual.status).toBe(409);
    expect(await manual.json()).toEqual({ ran: false, reason: 'NOT_RUNNING' });
  });

  it('refuses to start the engine while the kill switch is active', async () => {
    const trading = namespace(() => Response.json({ status: 'READY', config: null, runs: [], updatedAt: '' }));
    const env = makeEnv({ TRADING_STATE_STORE: trading.ns, RISK_STATE_STORE: namespace(() => Response.json({ active: true, updatedAt: '', liveArm: null })).ns });
    const response = await app.fetch(post('/trading/start', {}), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'KILL_SWITCH_ACTIVE' });
    expect(trading.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
});

describe('reconciliation route against KIS stubs', () => {
  function kisEnv(fetchMock: ReturnType<typeof vi.fn>, internalPositions: { symbol: string; quantity: number }[], baseUrl: string) {
    vi.stubGlobal('fetch', fetchMock);
    return makeEnv({
      KIS_BASE_URL: baseUrl,
      KIS_TOKEN_CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined } as unknown as KVNamespace,
      KIS_TOKEN_BROKER: namespace(() => Response.json({ accessToken: 'tok', expiresAt: Date.now() + 60_000 })).ns,
      INTERNAL_STATE_STORE: namespace(() => Response.json({ positions: internalPositions, orders: [], orderRecords: [] })).ns,
    });
  }
  const kisFetch = () => vi.fn(async (url: string) => {
    if (url.includes('inquire-balance')) return Response.json({ rt_cd: '0', output1: [{ pdno: '005930', hldg_qty: '3', prdt_name: 'a' }], output2: { dnca_tot_amt: '1000' } });
    if (url.includes('inquire-daily-ccld')) return Response.json({ rt_cd: '0', output1: [] });
    return Response.json({ rt_cd: '1', msg1: 'unexpected' }, { status: 500 });
  });

  it('reports a quantity mismatch between KIS and internal positions and blocks new orders', async () => {
    const env = kisEnv(kisFetch(), [{ symbol: '005930', quantity: 2 }], 'https://kis-recon-a.test');
    try {
      const response = await app.fetch(new Request('https://worker.test/reconciliation'), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'MISMATCHED', canPlaceNewOrders: false, differences: [expect.objectContaining({ type: 'POSITION_QUANTITY_MISMATCH', symbol: '005930' })] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('matches when internal positions equal the KIS snapshot', async () => {
    const env = kisEnv(kisFetch(), [{ symbol: '005930', quantity: 3 }], 'https://kis-recon-b.test');
    try {
      const response = await app.fetch(new Request('https://worker.test/reconciliation'), env);
      expect(await response.json()).toMatchObject({ status: 'MATCHED', canPlaceNewOrders: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
