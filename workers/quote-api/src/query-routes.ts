import { createAccountAdapter, createOrderAdapter, createQuoteAdapter, getEnvironment, isAccountConfigured, type Env } from './env';
import { errorResponse, json, type RouteContext } from './http';
import { todayKst } from './kis-common';
import { reconcileWithKis } from './kis-reconciliation';
import { parseSymbols, QUOTE_MAX_SYMBOLS, validateSymbols } from './quote-contract';

function requireAccount(env: Env, origin: string): Response | null {
  return isAccountConfigured(env) ? null : json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);
}

function parseOrderType(value: string | null): 'market' | 'limit' | null {
  if (!value || value === 'market') return 'market';
  if (value === 'limit') return 'limit';
  return null;
}

export async function handleQuotes({ url, env, origin }: RouteContext): Promise<Response> {
  const single = url.pathname === '/quote';
  const symbols = parseSymbols(url.searchParams.get(single ? 'symbol' : 'symbols'));
  if (!validateSymbols(symbols)) return json({ error: 'INVALID_SYMBOLS', maxSymbols: QUOTE_MAX_SYMBOLS }, 400, origin);

  try {
    const adapter = createQuoteAdapter(env);
    // 순차 호출: 한 종목이 실패하면 나머지 KIS 호출을 하지 않는다 (fail-fast, 호출 제한 보호)
    const quotes = [];
    for (const symbol of symbols) quotes.push(await adapter.getQuote(symbol));
    return json(single ? quotes[0] : quotes, 200, origin);
  } catch (error) {
    return errorResponse(error, origin, 'QUOTE');
  }
}

export async function handleAccount({ url, env, origin }: RouteContext): Promise<Response> {
  const blocked = requireAccount(env, origin);
  if (blocked) return blocked;
  const assets = url.pathname === '/account/assets';
  try {
    const adapter = createAccountAdapter(env);
    return json(assets ? await adapter.getAccountAssets() : await adapter.getSnapshot(), 200, origin);
  } catch (error) {
    return errorResponse(error, origin, assets ? 'ACCOUNT_ASSET' : 'ACCOUNT');
  }
}

export async function handleBuyable({ url, env, origin }: RouteContext): Promise<Response> {
  const blocked = requireAccount(env, origin);
  if (blocked) return blocked;
  const symbol = url.searchParams.get('symbol')?.trim() ?? '';
  const price = Number(url.searchParams.get('price')?.trim() ?? '');
  const orderType = parseOrderType(url.searchParams.get('orderType'));
  if (!/^\d{6}$/.test(symbol) || !Number.isFinite(price) || price <= 0 || !orderType) {
    return json({ error: 'INVALID_BUYABLE_PARAMS' }, 400, origin);
  }
  try {
    return json(await createAccountAdapter(env).getBuyable(symbol, price, orderType), 200, origin);
  } catch (error) {
    return errorResponse(error, origin, 'BUYABLE');
  }
}

export async function handleOrders({ url, env, origin }: RouteContext): Promise<Response> {
  const blocked = requireAccount(env, origin);
  if (blocked) return blocked;
  const today = todayKst();
  const startDate = url.searchParams.get('startDate')?.trim() || today;
  const endDate = url.searchParams.get('endDate')?.trim() || today;
  if (!/^\d{8}$/.test(startDate) || !/^\d{8}$/.test(endDate) || startDate > endDate) {
    return json({ error: 'INVALID_ORDER_HISTORY_PARAMS' }, 400, origin);
  }
  try {
    return json(await createOrderAdapter(env).getOrderHistory(startDate, endDate), 200, origin);
  } catch (error) {
    return errorResponse(error, origin, 'ORDERS');
  }
}

export async function handleReconciliation({ env, origin }: RouteContext): Promise<Response> {
  const blocked = requireAccount(env, origin);
  if (blocked) return blocked;
  try {
    const result = await reconcileWithKis(env);
    return json({ asOf: new Date().toISOString(), environment: getEnvironment(env), ...result }, 200, origin);
  } catch (error) {
    return errorResponse(error, origin, 'RECONCILIATION');
  }
}
