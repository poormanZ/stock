import { DurableObject } from 'cloudflare:workers';
import { parseEnvironment, resolveBaseUrl } from './kis-common';
import { isTokenUsable, type KISTokenRecord, KISTokenIssueError, requestKisToken, tokenCacheKey } from './kis-token';

interface TokenBrokerEnv {
  APP_KEY: string;
  APP_SECRET: string;
  KIS_ENVIRONMENT?: string;
  KIS_BASE_URL?: string;
  KIS_TOKEN_CACHE: KVNamespace;
}

const MAX_CACHE_TTL_SECONDS = 24 * 60 * 60;
const TOKEN_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const reason = error instanceof DOMException && error.name === 'AbortError'
      ? 'timed out'
      : error instanceof Error ? error.message.slice(0, 200) : 'network request failed';
    throw new Error(`KIS token upstream request failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** 여러 isolate의 동시 토큰 발급 요청을 한 곳으로 모아 KIS 발급 제한(1분 1회)을 넘지 않게 한다 */
export class KISTokenBroker extends DurableObject<TokenBrokerEnv> {
  private issuePromise: Promise<KISTokenRecord> | null = null;

  async fetch(request: Request): Promise<Response> {
    const baseUrl = resolveBaseUrl(parseEnvironment(this.env.KIS_ENVIRONMENT), this.env.KIS_BASE_URL);
    const key = tokenCacheKey(baseUrl);

    if (request.method === 'POST') {
      await this.env.KIS_TOKEN_CACHE.delete(key);
      return Response.json({ invalidated: true });
    }
    if (request.method !== 'GET') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });

    const cached = await this.env.KIS_TOKEN_CACHE.get<Partial<KISTokenRecord>>(key, 'json');
    if (isTokenUsable(cached)) return Response.json(cached);

    this.issuePromise ??= this.issueToken(baseUrl, key).finally(() => {
      this.issuePromise = null;
    });

    try {
      return Response.json(await this.issuePromise);
    } catch (error) {
      if (error instanceof KISTokenIssueError) {
        return Response.json(
          { error: 'KIS_TOKEN_ISSUE_FAILED', status: error.status, code: error.code, message: error.message.slice(0, 200) },
          { status: 502 },
        );
      }
      return Response.json(
        { error: 'KIS_TOKEN_ISSUE_FAILED', message: error instanceof Error ? error.message.slice(0, 200) : 'unknown error' },
        { status: 502 },
      );
    }
  }

  private async issueToken(baseUrl: string, key: string): Promise<KISTokenRecord> {
    const record = await requestKisToken(fetchWithTimeout, baseUrl, this.env.APP_KEY, this.env.APP_SECRET);
    const ttl = Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000));
    await this.env.KIS_TOKEN_CACHE.put(key, JSON.stringify(record), { expirationTtl: Math.min(ttl, MAX_CACHE_TTL_SECONDS) });
    return record;
  }
}
