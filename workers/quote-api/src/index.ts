import { KISAccountAdapter } from './kis-account-adapter';
import { KISHttpClient, KISHttpError } from './kis-http-client';
import { KISQuoteAdapter } from './kis-quote-adapter';
import { KISTokenBroker } from './kis-token-broker';
import { parseSymbols, QUOTE_MAX_SYMBOLS, validateSymbols } from './quote-contract';

// Durable Object class must be exported from the Worker entrypoint so Wrangler can bind it.
export { KISTokenBroker } from './kis-token-broker';

type KISEnvironment = 'PAPER' | 'LIVE';
interface Env {
  APP_KEY: string;
  APP_SECRET: string;
  ACCOUNT_CANO: string;
  ACCOUNT_PRODUCT_CODE: string;
  KIS_TOKEN_CACHE: KVNamespace;
  KIS_TOKEN_BROKER: DurableObjectNamespace;
  KIS_ENVIRONMENT?: KISEnvironment;
  KIS_BASE_URL?: string;
  ALLOWED_ORIGIN?: string;
}
function json(data: unknown, status = 200, origin = '*'): Response { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': 'content-type' } }); }
function getEnvironment(env: Env): KISEnvironment { return env.KIS_ENVIRONMENT === 'LIVE' ? 'LIVE' : 'PAPER'; }
function errorResponse(error: unknown, origin: string, scope: 'QUOTE' | 'ACCOUNT' | 'ACCOUNT_ASSET' | 'BUYABLE'): Response {
  if (error instanceof KISHttpError) { const status = error.code === 'KIS_TIMEOUT' ? 504 : error.code === 'KIS_RATE_LIMITED' ? 429 : 502; return json({ error: error.code }, status, origin); }
  if ((scope === 'ACCOUNT' || scope === 'ACCOUNT_ASSET') && error instanceof Error) {
    if (error.message === 'KIS account CANO must use 8 digits' || error.message === 'KIS account product code must use 2 digits') return json({ error: 'ACCOUNT_CONFIG_INVALID' }, 503, origin);
    const match = error.message.match(/^KIS (balance|account asset) request failed: ([A-Za-z0-9_-]+)$/);
    if (match) { console.error('KIS account request rejected', { msgCode: match[2] }); return json({ error: scope === 'ACCOUNT_ASSET' ? 'KIS_ACCOUNT_ASSET_REJECTED' : 'KIS_ACCOUNT_REJECTED', code: match[2] }, 502, origin); }
  }
  if (scope === 'BUYABLE' && error instanceof Error) { const match = error.message.match(/^KIS buyable request failed: ([A-Za-z0-9_-]+)$/); if (match) { console.error('KIS buyable request rejected', { msgCode: match[1] }); return json({ error: 'KIS_BUYABLE_REJECTED', code: match[1] }, 502, origin); } }
  const errorCode = scope === 'ACCOUNT' ? 'ACCOUNT_UNAVAILABLE' : scope === 'ACCOUNT_ASSET' ? 'ACCOUNT_ASSET_UNAVAILABLE' : scope === 'BUYABLE' ? 'BUYABLE_UNAVAILABLE' : 'QUOTE_UNAVAILABLE';
  console.error(`${scope} request failed`, error instanceof Error ? error.message : 'unknown error'); return json({ error: errorCode }, 502, origin);
}
function createClient(env: Env): KISHttpClient {
  return new KISHttpClient({
    appKey: env.APP_KEY,
    appSecret: env.APP_SECRET,
    environment: getEnvironment(env),
    baseUrl: env.KIS_BASE_URL,
    tokenCache: env.KIS_TOKEN_CACHE,
    tokenBroker: env.KIS_TOKEN_BROKER,
  });
}
function parseOrderType(value: string | null): 'market' | 'limit' | null { if (!value || value === 'market') return 'market'; if (value === 'limit') return 'limit'; return null; }

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const origin = env.ALLOWED_ORIGIN || '*'; if (request.method === 'OPTIONS') return json({}, 204, origin); if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, origin);
  const url = new URL(request.url); const accountConfigured = Boolean(env.ACCOUNT_CANO && env.ACCOUNT_PRODUCT_CODE);
  if (url.pathname === '/account' || url.pathname === '/account/assets') {
    if (!accountConfigured) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);
    try { const adapter = new KISAccountAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE); return json(url.pathname === '/account' ? await adapter.getSnapshot() : await adapter.getAccountAssets(), 200, origin); } catch (error) { return errorResponse(error, origin, url.pathname === '/account' ? 'ACCOUNT' : 'ACCOUNT_ASSET'); }
  }
  if (url.pathname === '/buyable') {
    if (!accountConfigured) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);
    const symbol = url.searchParams.get('symbol')?.trim() ?? ''; const priceText = url.searchParams.get('price')?.trim() ?? ''; const orderType = parseOrderType(url.searchParams.get('orderType')); const price = Number(priceText);
    if (!/^\d{6}$/.test(symbol) || !Number.isFinite(price) || price <= 0 || !orderType) return json({ error: 'INVALID_BUYABLE_PARAMS' }, 400, origin);
    try { const adapter = new KISAccountAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE); return json(await adapter.getBuyable(symbol, price, orderType), 200, origin); } catch (error) { return errorResponse(error, origin, 'BUYABLE'); }
  }
  if (url.pathname !== '/quote' && url.pathname !== '/quotes') return json({ error: 'NOT_FOUND' }, 404, origin);
  const symbols = url.pathname === '/quote' ? parseSymbols(url.searchParams.get('symbol')) : parseSymbols(url.searchParams.get('symbols')); if (!validateSymbols(symbols)) return json({ error: 'INVALID_SYMBOLS', maxSymbols: QUOTE_MAX_SYMBOLS }, 400, origin);
  try { const adapter = new KISQuoteAdapter(createClient(env)); const quotes = []; for (const symbol of symbols) quotes.push(await adapter.getQuote(symbol)); return json(url.pathname === '/quote' ? quotes[0] : quotes, 200, origin); } catch (error) { return errorResponse(error, origin, 'QUOTE'); }
} };
