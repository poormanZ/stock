import { KISHttpClient, KISHttpError } from './kis-http-client';
import { KISQuoteAdapter } from './kis-quote-adapter';

type KISEnvironment = 'PAPER' | 'LIVE';

interface Env {
  APP_KEY: string;
  APP_SECRET: string;
  KIS_ENVIRONMENT?: KISEnvironment;
  KIS_BASE_URL?: string;
  ALLOWED_ORIGIN?: string;
}

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

function getEnvironment(env: Env): KISEnvironment {
  return env.KIS_ENVIRONMENT === 'LIVE' ? 'LIVE' : 'PAPER';
}

function parseSymbols(value: string | null): string[] {
  return [...new Set((value ?? '').split(',').map((symbol) => symbol.trim()).filter(Boolean))];
}

function errorResponse(error: unknown, origin: string): Response {
  if (error instanceof KISHttpError) {
    const status = error.code === 'KIS_TIMEOUT' ? 504 : error.code === 'KIS_RATE_LIMITED' ? 429 : 502;
    return json({ error: error.code }, status, origin);
  }
  return json({ error: 'QUOTE_UNAVAILABLE' }, 502, origin);
}

function createQuoteAdapter(env: Env): KISQuoteAdapter {
  const client = new KISHttpClient({
    appKey: env.APP_KEY,
    appSecret: env.APP_SECRET,
    environment: getEnvironment(env),
    baseUrl: env.KIS_BASE_URL,
  });
  return new KISQuoteAdapter(client);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') return json({}, 204, origin);
    if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, origin);

    const url = new URL(request.url);
    if (url.pathname !== '/quote' && url.pathname !== '/quotes') {
      return json({ error: 'NOT_FOUND' }, 404, origin);
    }

    const symbols = url.pathname === '/quote'
      ? parseSymbols(url.searchParams.get('symbol'))
      : parseSymbols(url.searchParams.get('symbols'));

    if (symbols.length === 0 || symbols.length > 20 || symbols.some((symbol) => !/^\d{6}$/.test(symbol))) {
      return json({ error: 'INVALID_SYMBOLS' }, 400, origin);
    }

    try {
      const adapter = createQuoteAdapter(env);
      const quotes = [];
      for (const symbol of symbols) quotes.push(await adapter.getQuote(symbol));
      return json(url.pathname === '/quote' ? quotes[0] : quotes, 200, origin);
    } catch (error) {
      return errorResponse(error, origin);
    }
  },
};
