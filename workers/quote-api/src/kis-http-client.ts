import { type KISEnvironment, resolveBaseUrl } from './kis-common';
import { redactSensitiveText } from './kis-security';
import { isTokenUsable, type KISTokenRecord, KISTokenIssueError, requestKisToken, tokenCacheKey } from './kis-token';

export type KISHttpErrorCode =
  | 'KIS_AUTH_FAILED'
  | 'KIS_RATE_LIMITED'
  | 'KIS_TIMEOUT'
  | 'KIS_UPSTREAM_ERROR'
  | 'KIS_INVALID_RESPONSE';

export class KISHttpError extends Error {
  constructor(
    public readonly code: KISHttpErrorCode,
    message: string,
    public readonly status?: number,
    public readonly upstreamCode?: string,
  ) {
    super(message);
    this.name = 'KISHttpError';
  }
}

interface KISHttpClientOptions {
  appKey: string;
  appSecret: string;
  environment: KISEnvironment;
  baseUrl?: string;
  timeoutMs?: number;
  minRequestIntervalMs?: number;
  tokenCache?: KVNamespace;
  tokenBroker?: DurableObjectNamespace;
}

type BrokerTokenResponse = Partial<KISTokenRecord> & {
  error?: string;
  status?: number;
  code?: string;
  message?: string;
};
type KISRejectedResponse = { msg_cd?: string; msg1?: string; rt_cd?: string };

export interface KISJsonResponse<T> {
  data: T;
  headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PAPER_INTERVAL_MS = 1_100;
const MAX_ATTEMPTS = 3;
const TOKEN_AUTH_ERROR_CODES = new Set(['EGW00121', 'EGW00123']);

// isolate 단위 공유 상태: 동일 isolate의 클라이언트 인스턴스들이 토큰과 요청 간격을 함께 사용한다
let cachedToken: (KISTokenRecord & { baseUrl: string }) | null = null;
let tokenPromise: Promise<string> | null = null;
let requestChain: Promise<unknown> = Promise.resolve();
let nextRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return redactSensitiveText(error instanceof Error ? error.message : fallback).slice(0, 200);
}

export class KISHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly minRequestIntervalMs: number;

  constructor(private readonly options: KISHttpClientOptions) {
    this.baseUrl = resolveBaseUrl(options.environment, options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minRequestIntervalMs = options.minRequestIntervalMs
      ?? (options.environment === 'PAPER' ? DEFAULT_PAPER_INTERVAL_MS : 0);
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    const run = requestChain.then(async () => {
      await sleep(nextRequestAt - Date.now());
      nextRequestAt = Date.now() + this.minRequestIntervalMs;
      return operation();
    });
    requestChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return this.schedule(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new KISHttpError('KIS_TIMEOUT', 'KIS API request timed out');
        }
        throw new KISHttpError('KIS_UPSTREAM_ERROR', `KIS API request failed: ${safeErrorMessage(error, 'network error')}`);
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  async getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.baseUrl === this.baseUrl && cachedToken.expiresAt > Date.now()) {
      return cachedToken.accessToken;
    }
    tokenPromise ??= this.loadAccessToken().finally(() => {
      tokenPromise = null;
    });
    return tokenPromise;
  }

  private cacheKey(): string {
    return tokenCacheKey(this.baseUrl);
  }

  private remember(record: KISTokenRecord): string {
    cachedToken = { ...record, baseUrl: this.baseUrl };
    return record.accessToken;
  }

  private async loadAccessToken(): Promise<string> {
    const cached = await this.options.tokenCache?.get<Partial<KISTokenRecord>>(this.cacheKey(), 'json');
    if (isTokenUsable(cached)) return this.remember(cached);
    if (this.options.tokenBroker) return this.remember(await this.loadBrokerToken());
    return this.remember(await this.issueAccessToken());
  }

  private brokerStub(): DurableObjectStub {
    const broker = this.options.tokenBroker!;
    return broker.get(broker.idFromName(`KIS:${this.baseUrl}`));
  }

  private async loadBrokerToken(): Promise<KISTokenRecord> {
    let response: Response;
    try {
      response = await this.brokerStub().fetch('https://kis-token-broker/token');
    } catch (error) {
      throw new KISHttpError('KIS_UPSTREAM_ERROR', `KIS token broker request failed: ${safeErrorMessage(error, 'broker network error')}`);
    }
    let body: BrokerTokenResponse;
    try {
      body = ((await response.json()) ?? {}) as BrokerTokenResponse;
    } catch {
      throw new KISHttpError('KIS_INVALID_RESPONSE', 'KIS token broker response was not valid JSON', response.status);
    }
    if (!response.ok) {
      const detail = body.message ? `: ${body.message}` : '';
      throw new KISHttpError(
        body.code ? 'KIS_AUTH_FAILED' : 'KIS_UPSTREAM_ERROR',
        `KIS token broker rejected the request${detail}`,
        body.status ?? response.status,
        body.code,
      );
    }
    if (isTokenUsable(body)) return { accessToken: body.accessToken, expiresAt: body.expiresAt };
    throw new KISHttpError(
      'KIS_AUTH_FAILED',
      body.message ? `KIS token broker did not return a valid token: ${body.message}` : 'KIS token broker did not return a valid token',
      body.status,
      body.code,
    );
  }

  private async issueAccessToken(): Promise<KISTokenRecord> {
    let record: KISTokenRecord;
    try {
      record = await requestKisToken((url, init) => this.fetchWithTimeout(url, init), this.baseUrl, this.options.appKey, this.options.appSecret);
    } catch (error) {
      if (error instanceof KISTokenIssueError) {
        throw new KISHttpError(error.status === 429 ? 'KIS_RATE_LIMITED' : 'KIS_AUTH_FAILED', error.message, error.status, error.code);
      }
      throw error;
    }
    await this.options.tokenCache?.put(this.cacheKey(), JSON.stringify(record), {
      expirationTtl: Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000)),
    });
    return record;
  }

  private async invalidateTokenCache(): Promise<void> {
    cachedToken = null;
    await this.options.tokenCache?.delete(this.cacheKey());
    if (!this.options.tokenBroker) return;
    try {
      const response = await this.brokerStub().fetch('https://kis-token-broker/token', { method: 'POST' });
      if (!response.ok) console.error('KIS token broker cache invalidation failed', { status: response.status });
    } catch (error) {
      console.error('KIS token broker cache invalidation failed', safeErrorMessage(error, 'unknown error'));
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: unknown): Promise<KISJsonResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    let token = await this.getAccessToken();
    let tokenRefreshed = false;

    for (let attempt = 1; ; attempt += 1) {
      const response = await this.fetchWithTimeout(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          appkey: this.options.appKey,
          appsecret: this.options.appSecret,
          ...(body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      let data: T;
      try {
        data = (await response.json()) as T;
      } catch {
        throw new KISHttpError(response.ok ? 'KIS_INVALID_RESPONSE' : 'KIS_UPSTREAM_ERROR', 'KIS API response was not valid JSON', response.status);
      }

      const meta = (data ?? {}) as KISRejectedResponse;
      const authRejected = response.status === 401
        || response.status === 403
        || TOKEN_AUTH_ERROR_CODES.has(meta.msg_cd ?? '');

      if (authRejected) {
        if (tokenRefreshed) {
          throw new KISHttpError(
            'KIS_AUTH_FAILED',
            meta.msg1 ? `KIS API authentication failed: ${meta.msg1}` : 'KIS API authentication failed',
            response.status,
            meta.msg_cd,
          );
        }
        tokenRefreshed = true;
        await this.invalidateTokenCache();
        token = await this.getAccessToken();
        continue;
      }

      if (response.ok) return { data, headers: response.headers };

      const error = new KISHttpError(
        response.status === 429 ? 'KIS_RATE_LIMITED' : 'KIS_UPSTREAM_ERROR',
        meta.msg1 ? `KIS API request was rejected: ${meta.msg1}` : 'KIS API request was rejected',
        response.status,
        meta.msg_cd,
      );
      // 5xx 응답을 받은 POST(주문)는 KIS가 이미 처리했을 수 있어 재전송하면 중복 주문 위험이 있다.
      // 게이트웨이가 명시적으로 거부한 429만 재시도한다.
      const retryable = response.status === 429 || (method === 'GET' && response.status >= 500);
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(Math.max(this.minRequestIntervalMs, 500 * attempt));
    }
  }

  getJsonResponse<T>(path: string, headers: Record<string, string>): Promise<KISJsonResponse<T>> {
    return this.request<T>('GET', path, headers);
  }

  postJsonResponse<T>(path: string, body: unknown, headers: Record<string, string>): Promise<KISJsonResponse<T>> {
    return this.request<T>('POST', path, headers, body);
  }

  async getJson<T>(path: string, headers: Record<string, string>): Promise<T> {
    return (await this.request<T>('GET', path, headers)).data;
  }
}
