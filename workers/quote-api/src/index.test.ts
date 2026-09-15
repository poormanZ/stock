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
    const env = makeEnv({ RISK_STATE_STORE: namespace(() => { throw new Error('boom'); }).ns });
    const response = await app.fetch(new Request('https://worker.test/risk'), env);
    expect(response.status).toBe(500);
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
