interface Env {
  KIS_APP_KEY: string;
  KIS_APP_SECRET: string;
  KIS_BASE_URL?: string;
  ALLOWED_ORIGIN?: string;
}

type KISQuoteResponse = {
  rt_cd?: string;
  msg1?: string;
  output?: {
    stck_prpr?: string;
    prdy_vrss?: string;
    prdy_ctrt?: string;
    acml_vol?: string;
    stck_bsop_date?: string;
    iscd_stat_cls_code?: string;
  };
};

const DEFAULT_BASE_URL = 'https://openapi.koreainvestment.com:9443';
const TOKEN_PATH = '/oauth2/tokenP';
const QUOTE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-price';
const TOKEN_TTL_MS = 20 * 60 * 1000;

let cachedToken: { value: string; expiresAt: number } | null = null;
let tokenPromise: Promise<string> | null = null;

function json(data: unknown, status = 200, origin = '*'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

async function requestAccessToken(env: Env, baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
    }),
  });

  if (!response.ok) throw new Error(`KIS token request failed: ${response.status}`);
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('KIS access token was not returned');

  cachedToken = { value: body.access_token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return body.access_token;
}

async function getAccessToken(env: Env, baseUrl: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  if (!tokenPromise) {
    tokenPromise = requestAccessToken(env, baseUrl).finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
}

function toNumber(value: string | undefined): number {
  const parsed = Number(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

async function getQuote(env: Env, symbol: string): Promise<unknown> {
  if (!/^\d{6}$/.test(symbol)) throw new Error('Invalid domestic stock symbol');

  const baseUrl = env.KIS_BASE_URL || DEFAULT_BASE_URL;
  const token = await getAccessToken(env, baseUrl);
  const url = new URL(`${baseUrl}${QUOTE_PATH}`);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', symbol);

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
      tr_id: 'FHKST01010100',
      custtype: 'P',
    },
  });

  if (!response.ok) throw new Error(`KIS quote request failed: ${response.status}`);
  const body = (await response.json()) as KISQuoteResponse;
  if (body.rt_cd && body.rt_cd !== '0') throw new Error('KIS quote request was rejected');

  const output = body.output ?? {};
  return {
    symbol,
    price: toNumber(output.stck_prpr),
    change: toNumber(output.prdy_vrss),
    changePercent: toNumber(output.prdy_ctrt),
    volume: toNumber(output.acml_vol),
    asOf: output.stck_bsop_date ?? '',
    market: 'KRX',
    source: 'KIS OPEN API',
    delayed: false,
  };
}

async function getQuotes(env: Env, symbols: string[]): Promise<unknown[]> {
  return Promise.all(symbols.map((symbol) => getQuote(env, symbol)));
}

function parseSymbols(value: string | null): string[] {
  return [...new Set((value ?? '').split(',').map((symbol) => symbol.trim()).filter(Boolean))];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') return json({}, 204, origin);
    if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, origin);

    const url = new URL(request.url);
    if (url.pathname !== '/quote' && url.pathname !== '/quotes') return json({ error: 'NOT_FOUND' }, 404, origin);

    const symbols = url.pathname === '/quote'
      ? parseSymbols(url.searchParams.get('symbol'))
      : parseSymbols(url.searchParams.get('symbols'));

    if (symbols.length === 0 || symbols.length > 20 || symbols.some((symbol) => !/^\d{6}$/.test(symbol))) {
      return json({ error: 'INVALID_SYMBOLS' }, 400, origin);
    }

    try {
      const quotes = await getQuotes(env, symbols);
      return json(url.pathname === '/quote' ? quotes[0] : quotes, 200, origin);
    } catch {
      cachedToken = null;
      return json({ error: 'QUOTE_UNAVAILABLE' }, 502, origin);
    }
  },
};
