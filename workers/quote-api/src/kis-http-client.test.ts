import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KISHttpClient, KISHttpError } from './kis-http-client';

const TOKEN = { access_token: 'token-1', access_token_token_expired: '2099-01-01 00:00:00' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function kvStub() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => { const value = store.get(key); return value ? JSON.parse(value) : null; }),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}

function client(baseUrl: string, tokenCache?: ReturnType<typeof kvStub>): KISHttpClient {
  return new KISHttpClient({ appKey: 'k', appSecret: 's', environment: 'LIVE', baseUrl, tokenCache: tokenCache as unknown as KVNamespace });
}

describe('KISHttpClient', () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('issues a token once, stores it in KV as {accessToken, expiresAt} and reuses it', async () => {
    const kv = kvStub();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(TOKEN))
      .mockResolvedValueOnce(jsonResponse({ rt_cd: '0', output: { a: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ rt_cd: '0', output: { a: 2 } }));

    const api = client('https://kis-a.test', kv);
    await api.getJson('/first', { tr_id: 'X' });
    await client('https://kis-a.test', kv).getJson('/second', { tr_id: 'X' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('https://kis-a.test/oauth2/tokenP');
    const record = JSON.parse(kv.store.get('kis-access-token:https://kis-a.test')!);
    expect(record).toMatchObject({ accessToken: 'token-1' });
    expect(typeof record.expiresAt).toBe('number');
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).authorization).toBe('Bearer token-1');
  });

  it('refreshes the token once after an authentication rejection', async () => {
    const kv = kvStub();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(TOKEN))
      .mockResolvedValueOnce(jsonResponse({ rt_cd: '1', msg_cd: 'EGW00123', msg1: 'expired' }, 200))
      .mockResolvedValueOnce(jsonResponse({ ...TOKEN, access_token: 'token-2' }))
      .mockResolvedValueOnce(jsonResponse({ rt_cd: '0', output: {} }));

    const result = await client('https://kis-b.test', kv).getJsonResponse<{ rt_cd: string }>('/balance', { tr_id: 'X' });

    expect(result.data.rt_cd).toBe('0');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(kv.delete).toHaveBeenCalledWith('kis-access-token:https://kis-b.test');
    expect((fetchMock.mock.calls[3][1]?.headers as Record<string, string>).authorization).toBe('Bearer token-2');
  });

  it('does not retry a POST that failed with 5xx (possible duplicate order)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(TOKEN))
      .mockResolvedValueOnce(jsonResponse({ rt_cd: '1', msg1: 'upstream down' }, 502));

    await expect(client('https://kis-c.test').postJsonResponse('/order', { a: 1 }, { tr_id: 'X' }))
      .rejects.toMatchObject({ code: 'KIS_UPSTREAM_ERROR', status: 502 } satisfies Partial<KISHttpError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a GET on 5xx up to three attempts', async () => {
    // Date는 실제 시계를 유지해 모듈 전역 rate-limit 타임스탬프가 다음 테스트로 새지 않게 한다
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(TOKEN))
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ rt_cd: '0', output: { ok: true } }));

    const pending = client('https://kis-d.test').getJson<{ output: { ok: boolean } }>('/quote', { tr_id: 'X' });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ output: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('maps a rejected token issuance to KIS_AUTH_FAILED with the gateway code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error_code: 'EGW00133', error_description: 'wait' }, 403));
    await expect(client('https://kis-e.test').getJson('/quote', { tr_id: 'X' }))
      .rejects.toMatchObject({ code: 'KIS_AUTH_FAILED', upstreamCode: 'EGW00133', status: 403 } satisfies Partial<KISHttpError>);
  });
});
