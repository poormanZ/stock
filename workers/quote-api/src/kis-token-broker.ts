import { DurableObject } from 'cloudflare:workers';

interface TokenCacheRecord {
  accessToken: string;
  expiresAt: number;
}

interface TokenBrokerEnv {
  APP_KEY: string;
  APP_SECRET: string;
  KIS_ENVIRONMENT?: 'PAPER' | 'LIVE';
  KIS_BASE_URL?: string;
  KIS_TOKEN_CACHE: KVNamespace;
}

const LIVE_BASE_URL = 'https://openapi.koreainvestment.com:9443';
const PAPER_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
const TOKEN_PATH = '/oauth2/tokenP';
const TOKEN_VALIDITY_SECONDS = 24 * 60 * 60;

type KISRejectedResponse = { msg_cd?: string; msg1?: string; rt_cd?: string };

type KISTokenResponse = KISRejectedResponse & {
  access_token?: string;
  access_token_token_expired?: string;
};

function getBaseUrl(env: TokenBrokerEnv): string {
  if (env.KIS_BASE_URL) return env.KIS_BASE_URL.replace(/\/$/, '');
  return env.KIS_ENVIRONMENT === 'LIVE' ? LIVE_BASE_URL : PAPER_BASE_URL;
}

function toExpiry(value?: string): number {
  if (!value) return Date.now() + TOKEN_VALIDITY_SECONDS * 1000;
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : Date.now() + TOKEN_VALIDITY_SECONDS * 1000;
}

async function readResponseBody(response: Response): Promise<KISTokenResponse> {
  try {
    const body = (await response.json()) as KISTokenResponse;
    return body ?? {};
  } catch {
    return {};
  }
}

function rejectionMessage(status: number, body: KISTokenResponse): string {
  const parts = [`KIS token request rejected (${status})`];
  if (body.msg_cd) parts.push(body.msg_cd);
  if (body.msg1) parts.push(body.msg1.slice(0, 200));
  return parts.join(' ');
}

export class KISTokenBroker extends DurableObject<TokenBrokerEnv> {
  private issuePromise: Promise<TokenCacheRecord> | null = null;

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const baseUrl = getBaseUrl(this.env);
    const key = `kis-access-token:${baseUrl}`;

    if (request.method === 'POST') {
      await this.env.KIS_TOKEN_CACHE.delete(key);
      return Response.json({ invalidated: true });
    }

    const cached = await this.env.KIS_TOKEN_CACHE.get<TokenCacheRecord>(key, 'json');
    if (cached && cached.accessToken && cached.expiresAt > Date.now()) {
      return Response.json(cached);
    }

    if (!this.issuePromise) {
      this.issuePromise = this.issueToken(baseUrl, key).finally(() => {
        this.issuePromise = null;
      });
    }

    try {
      return Response.json(await this.issuePromise);
    } catch (error) {
      const detail = error instanceof Error ? error : new Error('unknown error');
      const match = detail.message.match(/^KIS token request rejected \((\d+)\)(?:\s+([A-Za-z0-9_-]+))?(?:\s+(.+))?$/);
      if (match) {
        return Response.json(
          {
            error: 'KIS_TOKEN_ISSUE_FAILED',
            status: Number(match[1]),
            code: match[2],
            message: match[3]?.slice(0, 200),
          },
          { status: 502 },
        );
      }
      return Response.json(
        { error: 'KIS_TOKEN_ISSUE_FAILED', message: detail.message.slice(0, 200) },
        { status: 502 },
      );
    }
  }

  private async issueToken(baseUrl: string, key: string): Promise<TokenCacheRecord> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: this.env.APP_KEY,
          appsecret: this.env.APP_SECRET,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network request failed';
      throw new Error(`KIS token upstream request failed: ${message.slice(0, 200)}`);
    }

    const body = await readResponseBody(response);
    if (!response.ok || (body.rt_cd !== undefined && body.rt_cd !== '0')) {
      throw new Error(rejectionMessage(response.status, body));
    }

    if (!body.access_token) {
      throw new Error(rejectionMessage(response.status, body));
    }

    const record: TokenCacheRecord = {
      accessToken: body.access_token,
      expiresAt: toExpiry(body.access_token_token_expired),
    };
    const ttl = Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000));
    await this.env.KIS_TOKEN_CACHE.put(key, JSON.stringify(record), {
      expirationTtl: Math.min(ttl, TOKEN_VALIDITY_SECONDS),
    });
    return record;
  }
}
