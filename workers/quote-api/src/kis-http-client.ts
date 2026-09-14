import type { KISTokenBroker } from './kis-token-broker';

export type KISEnvironment = 'PAPER' | 'LIVE';

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
  tokenBroker?: DurableObjectNamespace<KISTokenBroker>;
}

type KISTokenResponse = {
  access_token?: string;
  access_token_token_expired?: string;
};

type CachedToken = { value: string; expiresAt: number; baseUrl: string };

type BrokerTokenResponse = { accessToken?: string; expiresAt?: number; error?: string };

export interface KISJsonResponse<T> {
  data: T;
  headers: Headers;
}

const LIVE_BASE_URL = 'https://openapi.koreainvestment.com:9443';
const PAPER_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
const TOKEN_PATH = '/oauth2/tokenP';
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PAPER_INTERVAL_MS = 1_100;

let cachedToken: CachedToken | null = null;
let tokenPromise: Promise<string> | null = null;
let requestChain = Promise.resolve();
let nextRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function getBaseUrl(options: KISHttpClientOptions): string {
  if (options.baseUrl) return options.baseUrl.replace(/\/$/, '');
  return options.environment === 'LIVE' ? LIVE_BASE_URL : PAPER_BASE_URL;
}

function toExpiry(value?: string): number {
  if (!value) return Date.now() + 6 * 60 * 60 * 1000;
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(parsed)
    ? Math.max(Date.now() + TOKEN_SAFETY_MARGIN_MS, parsed - TOKEN_SAFETY_MARGIN_MS)
    : Date.now() + 6 * 60 * 60 * 1000;
}

export class KISHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly minRequestIntervalMs: number;

  constructor(private readonly options: KISHttpClientOptions) {
    this.baseUrl = getBaseUrl(options);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minRequestIntervalMs = options.minRequestIntervalMs
      ?? (options.environment === 'PAPER' ? DEFAULT_PAPER_INTERVAL_MS : 0);
  }

  private async schedule<T>(operation: () => Promise<T>): Promise<T> {
    const run = requestChain.then(async () => {
      const waitMs = Math.max(0, nextRequestAt - Date.now());
      await sleep(waitMs);
      nextRequestAt = Date.now() + this.minRequestIntervalMs;
      return operation();
    });
    requestChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return this.schedule(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new KISHttpError('KIS_TIMEOUT', 'KIS API request timed out');
        }
        throw new KISHttpError('KIS_UPSTREAM_ERROR', 'KIS API request failed');
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  async getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.baseUrl === this.baseUrl && cachedToken.expiresAt > Date.now()) {
      return cachedToken.value;
    }

    if (!tokenPromise) {
      tokenPromise = this.loadAccessToken().finally(() => {
        tokenPromise = null;
      });
    }
    return tokenPromise;
  }

  private async loadAccessToken(): Promise<string> {
    if (this.options.tokenCache) {
      const cached = await this.options.tokenCache.get<CachedToken>(this.cacheKey(), 'json');
      if (cached?.value && cached.expiresAt > Date.now()) {
        cachedToken = cached;
        return cached.value;
      }
    }

    if (this.options.tokenBroker) {
      const id = this.options.tokenBroker.idFromName(`KIS:${this.baseUrl}`);
      let response: Response;
      try {
        response = await id.fetch('https://kis-token-broker/token');
      } catch {
        throw new KISHttpError('KIS_UPSTREAM_ERROR', 'KIS token broker request failed');
      }
      if (!response.ok) {
        throw new KISHttpError('KIS_AUTH_FAILED', 'KIS token broker rejected the request', response.status);
      }
      const body = (await response.json()) as BrokerTokenResponse;
      if (body.accessToken && body.expiresAt && body.expiresAt > Date.now()) {
        cachedToken = { value: body.accessToken, expiresAt: body.expiresAt, baseUrl: this.baseUrl };
        return body.accessToken;
      }
      throw new KISHttpError('KIS_AUTH_FAILED', 'KIS token broker did not return a valid token');
    }

    return this.issueAccessToken();
  }

  private cacheKey(): string {
    return `kis-access-token:${this.baseUrl}`;
  }

  private async issueAccessToken(): Promise<string> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: this.options.appKey,
        appsecret: this.options.appSecret,
      }),
    });

    if (!response.ok) {
      const code = response.status === 429 ? 'KIS_RATE_LIMITED' : 'KIS_AUTH_FAILED';
      throw new KISHttpError(code, 'KIS access token request was rejected', response.status);
    }

    let body: KISTokenResponse;
    try {
      body = (await response.json()) as KISTokenResponse;
    } catch {
      throw new KISHttpError('KIS_INVALID_RESPONSE', 'KIS token response was invalid');
    }

    if (!body.access_token) {
      throw new KISHttpError('KIS_AUTH_FAILED', 'KIS access token was not returned');
    }

    const record: CachedToken = {
      value: body.access_token,
      expiresAt: toExpiry(body.access_token_token_expired),
      baseUrl: this.baseUrl,
    };
    cachedToken = record;
    if (this.options.tokenCache) {
      await this.options.tokenCache.put(this.cacheKey(), JSON.stringify(record), {
        expirationTtl: Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000)),
      });
    }
    return body.access_token;
  }

  async getJsonResponse<T>(path: string, headers: Record<string, string>): Promise<KISJsonResponse<T>> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}${path}`;
    let lastError: KISHttpError | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetchWithTimeout(url, {
        headers: {
          authorization: `Bearer ${token}`,
          appkey: this.options.appKey,
          appsecret: this.options.appSecret,
          ...headers,
        },
      });

      if (response.ok) {
        try {
          return { data: (await response.json()) as T, headers: response.headers };
        } catch {
          throw new KISHttpError('KIS_INVALID_RESPONSE', 'KIS response was not valid JSON');
        }
      }

      const retryable = response.status === 429 || response.status >= 500;
      lastError = new KISHttpError(
        response.status === 429 ? 'KIS_RATE_LIMITED' : 'KIS_UPSTREAM_ERROR',
        'KIS API request was rejected',
        response.status,
      );
      if (!retryable || attempt === 2) throw lastError;
      await sleep(Math.max(this.minRequestIntervalMs, 500 * (attempt + 1)));
    }

    throw lastError ?? new KISHttpError('KIS_UPSTREAM_ERROR', 'KIS API request failed');
  }

  async getJson<T>(path: string, headers: Record<string, string>): Promise<T> {
    return (await this.getJsonResponse<T>(path, headers)).data;
  }

  invalidateToken(): void {
    cachedToken = null;
  }
}
