import type { KISResponseMeta } from './kis-common';

export interface KISTokenRecord {
  accessToken: string;
  expiresAt: number;
}

export const TOKEN_PATH = '/oauth2/tokenP';
export const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_VALIDITY_MS = 24 * 60 * 60 * 1000;

type KISTokenResponse = KISResponseMeta & {
  access_token?: string;
  access_token_token_expired?: string;
  error_code?: string;
  error_description?: string;
};

export class KISTokenIssueError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = 'KISTokenIssueError';
  }
}

export type TokenFetcher = (url: string, init: RequestInit) => Promise<Response>;

export function tokenCacheKey(baseUrl: string): string {
  return `kis-access-token:${baseUrl}`;
}

export function isTokenUsable(record: Partial<KISTokenRecord> | null | undefined, now = Date.now()): record is KISTokenRecord {
  return Boolean(record?.accessToken) && typeof record?.expiresAt === 'number' && record.expiresAt > now;
}

/**
 * KIS 만료시각("YYYY-MM-DD HH:mm:ss", KST)을 안전 마진을 뺀 epoch ms로 변환한다.
 * 타임존을 붙이지 않으면 UTC로 해석되어 실제보다 9시간 늦게 만료 처리되므로 +09:00을 명시한다.
 */
export function toTokenExpiry(value: string | undefined, now = Date.now()): number {
  const fallback = now + DEFAULT_TOKEN_VALIDITY_MS - TOKEN_SAFETY_MARGIN_MS;
  if (!value) return fallback;
  const parsed = Date.parse(`${value.trim().replace(' ', 'T')}+09:00`);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(now + TOKEN_SAFETY_MARGIN_MS, parsed - TOKEN_SAFETY_MARGIN_MS);
}

export async function requestKisToken(fetcher: TokenFetcher, baseUrl: string, appKey: string, appSecret: string): Promise<KISTokenRecord> {
  const response = await fetcher(`${baseUrl}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const body: KISTokenResponse = await response.json().then((value) => (value ?? {}) as KISTokenResponse, () => ({}));
  const code = body.msg_cd ?? body.error_code;
  const detail = (body.msg1 ?? body.error_description)?.trim();
  const rejected = !response.ok || (body.rt_cd !== undefined && body.rt_cd !== '0');
  if (rejected || !body.access_token) {
    const reason = rejected ? 'KIS access token request was rejected' : 'KIS access token was not returned';
    throw new KISTokenIssueError(detail ? `${reason}: ${detail.slice(0, 200)}` : reason, response.status, code);
  }
  return { accessToken: body.access_token, expiresAt: toTokenExpiry(body.access_token_token_expired) };
}
