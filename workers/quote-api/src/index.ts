import { KISAccountAdapter } from './kis-account-adapter';
import { KISHttpClient, KISHttpError } from './kis-http-client';
import { KISOrderAdapter } from './kis-order-adapter';
import { KISPaperOrderAdapter, toPaperAcceptedOrder } from './kis-paper-order-adapter';
import { KISQuoteAdapter } from './kis-quote-adapter';
import { KISTokenBroker } from './kis-token-broker';
import { InternalStateStoreDO } from './internal-state-store';
import { DryRunStateStoreDO } from './dry-run-simulator';
import { RiskStateStoreDO, DEFAULT_RISK_CONFIG, checkRisk } from './risk-manager';
import { assertOrderRequest, transitionOrder, type CreateOrderRequest, type Order } from './order-domain';
import { checkNewOrderGate } from './order-gate';
import { parseSymbols, QUOTE_MAX_SYMBOLS, validateSymbols } from './quote-contract';
import { reconcile } from './reconciliation';

export { KISTokenBroker } from './kis-token-broker';
export { InternalStateStoreDO } from './internal-state-store';
export { DryRunStateStoreDO } from './dry-run-simulator';
export { RiskStateStoreDO } from './risk-manager';

type KISEnvironment = 'PAPER' | 'LIVE';

interface Env {
  APP_KEY: string;
  APP_SECRET: string;
  ACCOUNT_CANO: string;
  ACCOUNT_PRODUCT_CODE: string;
  KIS_TOKEN_CACHE: KVNamespace;
  KIS_TOKEN_BROKER: DurableObjectNamespace;
  INTERNAL_STATE_STORE: DurableObjectNamespace;
  DRY_RUN_STATE_STORE: DurableObjectNamespace;
  RISK_STATE_STORE: DurableObjectNamespace;
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
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

function getEnvironment(env: Env): KISEnvironment {
  return env.KIS_ENVIRONMENT === 'LIVE' ? 'LIVE' : 'PAPER';
}

function errorResponse(
  error: unknown,
  origin: string,
  scope: 'QUOTE' | 'ACCOUNT' | 'ACCOUNT_ASSET' | 'BUYABLE' | 'ORDERS' | 'RECONCILIATION',
): Response {
  if (error instanceof KISHttpError) {
    const status = error.code === 'KIS_TIMEOUT' ? 504 : error.code === 'KIS_RATE_LIMITED' ? 429 : 502;
    const body: Record<string, unknown> = { error: error.code };
    if (error.status !== undefined) body.status = error.status;
    if (error.upstreamCode) body.code = error.upstreamCode;
    if (error.message) body.message = error.message.slice(0, 300);
    console.error(`${scope} KIS HTTP request failed`, {
      code: error.code,
      status: error.status,
      upstreamCode: error.upstreamCode,
      message: error.message,
    });
    return json(body, status, origin);
  }

  if ((scope === 'ACCOUNT' || scope === 'ACCOUNT_ASSET') && error instanceof Error) {
    if (
      error.message === 'KIS account CANO must use 8 digits' ||
      error.message === 'KIS account product code must use 2 digits'
    ) {
      return json({ error: 'ACCOUNT_CONFIG_INVALID' }, 503, origin);
    }
    const match = error.message.match(/^KIS (balance|account asset) request failed: ([A-Za-z0-9_-]+)$/);
    if (match) {
      return json(
        { error: scope === 'ACCOUNT_ASSET' ? 'KIS_ACCOUNT_ASSET_REJECTED' : 'KIS_ACCOUNT_REJECTED', code: match[2] },
        502,
        origin,
      );
    }
  }

  if (scope === 'BUYABLE' && error instanceof Error) {
    const match = error.message.match(/^KIS buyable request failed: ([A-Za-z0-9_-]+)$/);
    if (match) return json({ error: 'KIS_BUYABLE_REJECTED', code: match[1] }, 502, origin);
  }

  if (scope === 'ORDERS' && error instanceof Error) {
    const match = error.message.match(/^KIS order history request failed: ([A-Za-z0-9_-]+)$/);
    if (match) return json({ error: 'KIS_ORDER_HISTORY_REJECTED', code: match[1] }, 502, origin);
  }

  if (scope === 'RECONCILIATION' && error instanceof Error && error.message === 'INTERNAL_STATE_UNAVAILABLE') {
    return json({ error: 'RECONCILIATION_UNAVAILABLE', message: error.message }, 503, origin);
  }

  const errorCode =
    scope === 'ACCOUNT'
      ? 'ACCOUNT_UNAVAILABLE'
      : scope === 'ACCOUNT_ASSET'
        ? 'ACCOUNT_ASSET_UNAVAILABLE'
        : scope === 'BUYABLE'
          ? 'BUYABLE_UNAVAILABLE'
          : scope === 'ORDERS'
            ? 'ORDERS_UNAVAILABLE'
            : scope === 'RECONCILIATION'
              ? 'RECONCILIATION_UNAVAILABLE'
              : 'QUOTE_UNAVAILABLE';
  return json({ error: errorCode, message: error instanceof Error ? error.message.slice(0, 300) : 'unknown error' }, 502, origin);
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

function parseOrderType(value: string | null): 'market' | 'limit' | null {
  if (!value || value === 'market') return 'market';
  if (value === 'limit') return 'limit';
  return null;
}

function getKstDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return `${values.year}${values.month}${values.day}`;
}

function parseDateParam(value: string | null, fallback: string): string {
  return value?.trim() || fallback;
}

async function loadReconciliation(env: Env): Promise<ReturnType<typeof reconcile>> {
  const id = env.INTERNAL_STATE_STORE.idFromName('primary');
  const store = env.INTERNAL_STATE_STORE.get(id);
  const [account, orders] = await Promise.all([
    new KISAccountAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE).getSnapshot(),
    new KISOrderAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE).getOrderHistory(getKstDate(), getKstDate()),
  ]);
  const internal = await store.fetch('https://internal-state/');
  if (!internal.ok) throw new Error('INTERNAL_STATE_UNAVAILABLE');
  const internalState = (await internal.json()) as {
    positions: { symbol: string; quantity: number }[];
    orders: {
      brokerOrderId: string;
      status: string;
      symbol: string;
      side: 'buy' | 'sell' | 'unknown';
      quantity: number;
      executedQuantity: number;
    }[];
  };
  return reconcile(
    {
      positions: account.positions.map((p) => ({ symbol: p.symbol, quantity: p.quantity })),
      orders: orders.orders.map((o) => ({
        brokerOrderId: o.brokerOrderId,
        status: o.status,
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity,
        executedQuantity: o.executedQuantity,
      })),
    },
    internalState,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') return json({}, 204, origin);

    const url = new URL(request.url);
    const riskId = env.RISK_STATE_STORE.idFromName('primary');
    const riskStore = env.RISK_STATE_STORE.get(riskId);

    if (url.pathname === '/risk' && request.method === 'GET') {
      return riskStore.fetch('https://risk-state/');
    }

    if (url.pathname === '/risk/kill-switch' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return json({ error: 'INVALID_KILL_SWITCH_REQUEST' }, 400, origin);
      return riskStore.fetch(
        new Request('https://risk-state/', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
      );
    }

    if (url.pathname === '/dry-run' && request.method === 'GET') {
      const id = env.DRY_RUN_STATE_STORE.idFromName('primary');
      return env.DRY_RUN_STATE_STORE.get(id).fetch('https://dry-run-state/');
    }

    if (url.pathname === '/dry-run/orders' && request.method === 'POST') {
      const id = env.DRY_RUN_STATE_STORE.idFromName('primary');
      const store = env.DRY_RUN_STATE_STORE.get(id);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return json({ error: 'INVALID_DRY_RUN_REQUEST' }, 400, origin);

      const candidate = body as {
        request?: CreateOrderRequest;
        referencePrice?: number;
        fillQuantity?: number;
        config?: unknown;
      };

      try {
        assertOrderRequest(candidate.request as CreateOrderRequest);
      } catch {
        return json({ error: 'INVALID_ORDER' }, 400, origin);
      }

      if (!Number.isFinite(candidate.referencePrice)) return json({ error: 'INVALID_REFERENCE_PRICE' }, 400, origin);

      try {
        const riskResponse = await riskStore.fetch('https://risk-state/');
        const killSwitch = (await riskResponse.json()) as { active: boolean };
        const dryResponse = await store.fetch('https://dry-run-state/');
        if (!dryResponse.ok) throw new Error('DRY_RUN_STATE_UNAVAILABLE');
        const dryState = (await dryResponse.json()) as {
          positions: { symbol: string; quantity: number }[];
          orders: import('./order-domain').Order[];
          dailyLoss?: number;
        };

        const now = new Date().toISOString();
        const risk = checkRisk({
          request: candidate.request as CreateOrderRequest,
          state: dryState,
          market: {
            referencePrice: candidate.referencePrice as number,
            quoteAsOf: now,
            now,
          },
          config: DEFAULT_RISK_CONFIG,
          killSwitchActive: killSwitch.active,
          reconciliationAllowed: true,
          apiHealthy: true,
        });
        if (!risk.allowed) return json({ error: risk.reason, risk }, 409, origin);

        return store.fetch(
          new Request('https://dry-run-state/', {
            method: 'POST',
            body: JSON.stringify({ ...candidate, action: 'order' }),
            headers: { 'content-type': 'application/json' },
          }),
        );
      } catch (error) {
        console.error('DRY_RUN order failed', error);
        return json({ error: 'DRY_RUN_UNAVAILABLE', message: error instanceof Error ? error.message.slice(0, 300) : 'unknown error' }, 503, origin);
      }
    }

    if (url.pathname === '/dry-run/reset' && request.method === 'POST') {
      const id = env.DRY_RUN_STATE_STORE.idFromName('primary');
      const store = env.DRY_RUN_STATE_STORE.get(id);
      const body = await request.json().catch(() => ({}));
      return store.fetch(
        new Request('https://dry-run-state/', {
          method: 'POST',
          body: JSON.stringify({ ...(body as object), action: 'reset' }),
          headers: { 'content-type': 'application/json' },
        }),
      );
    }

    if (url.pathname === '/paper/orders' && request.method === 'POST') {
      if (getEnvironment(env) !== 'PAPER') return json({ error: 'PAPER_ENVIRONMENT_REQUIRED' }, 409, origin);
      if (!env.ACCOUNT_CANO || !env.ACCOUNT_PRODUCT_CODE) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);

      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return json({ error: 'INVALID_PAPER_ORDER_REQUEST' }, 400, origin);
      const candidate = body as { request?: CreateOrderRequest; referencePrice?: number };
      const requestBody = candidate.request as CreateOrderRequest;
      try {
        assertOrderRequest(requestBody);
      } catch {
        return json({ error: 'INVALID_ORDER' }, 400, origin);
      }
      if (!Number.isFinite(candidate.referencePrice)) return json({ error: 'INVALID_REFERENCE_PRICE' }, 400, origin);

      try {
        const internalId = env.INTERNAL_STATE_STORE.idFromName('primary');
        const internalStore = env.INTERNAL_STATE_STORE.get(internalId);
        const internalResponse = await internalStore.fetch('https://internal-state/');
        if (!internalResponse.ok) throw new Error('INTERNAL_STATE_UNAVAILABLE');
        const internalState = (await internalResponse.json()) as {
          positions: { symbol: string; quantity: number }[];
          orders: { brokerOrderId: string; status: string; symbol: string; side: 'buy' | 'sell' | 'unknown'; quantity: number; executedQuantity: number; clientOrderId?: string }[];
          orderRecords?: Order[];
        };
        const existing = (internalState.orderRecords ?? []).find((order) => order.clientOrderId === requestBody.clientOrderId);
        if (existing) return json({ idempotent: true, order: existing }, 200, origin);

        const [reconciliation, quote] = await Promise.all([
          loadReconciliation(env),
          new KISQuoteAdapter(createClient(env)).getQuote(requestBody.symbol),
        ]);
        const gate = checkNewOrderGate(requestBody, reconciliation);
        if (!gate.allowed) return json({ error: gate.reason, reconciliation }, 409, origin);

        const riskResponse = await riskStore.fetch('https://risk-state/');
        const killSwitch = (await riskResponse.json()) as { active: boolean };
        const risk = checkRisk({
          request: requestBody,
          state: internalState,
          market: {
            referencePrice: candidate.referencePrice as number,
            quoteAsOf: (quote as { asOf?: string }).asOf,
            now: new Date().toISOString(),
          },
          config: DEFAULT_RISK_CONFIG,
          killSwitchActive: killSwitch.active,
          reconciliationAllowed: reconciliation.canPlaceNewOrders,
          apiHealthy: true,
        });
        if (!risk.allowed) return json({ error: risk.reason, risk, reconciliation }, 409, origin);

        const now = new Date().toISOString();
        let order: Order = {
          id: requestBody.id,
          clientOrderId: requestBody.clientOrderId,
          symbol: requestBody.symbol,
          side: requestBody.side,
          orderType: requestBody.orderType,
          quantity: requestBody.quantity,
          limitPrice: requestBody.limitPrice,
          executedQuantity: 0,
          averageExecutedPrice: 0,
          status: 'CREATED',
          createdAt: now,
          updatedAt: now,
        };
        order = transitionOrder(order, 'SUBMITTING');
        await internalStore.fetch(new Request('https://internal-state/', {
          method: 'POST',
          body: JSON.stringify({ action: 'apply-order', order }),
          headers: { 'content-type': 'application/json' },
        }));

        try {
          const submission = await new KISPaperOrderAdapter(
            createClient(env),
            getEnvironment(env),
            env.ACCOUNT_CANO,
            env.ACCOUNT_PRODUCT_CODE,
          ).submit(requestBody);

          if (!submission.accepted) {
            order = transitionOrder(order, 'REJECTED');
            await internalStore.fetch(new Request('https://internal-state/', {
              method: 'POST',
              body: JSON.stringify({ action: 'apply-order', order }),
              headers: { 'content-type': 'application/json' },
            }));
            return json({ error: 'PAPER_ORDER_REJECTED', code: submission.messageCode, message: submission.message, order }, 409, origin);
          }

          order = toPaperAcceptedOrder(order, submission);
          await internalStore.fetch(new Request('https://internal-state/', {
            method: 'POST',
            body: JSON.stringify({ action: 'apply-order', order }),
            headers: { 'content-type': 'application/json' },
          }));
          return json({ order, messageCode: submission.messageCode, message: submission.message }, 200, origin);
        } catch (error) {
          order = transitionOrder(order, 'UNKNOWN');
          await internalStore.fetch(new Request('https://internal-state/', {
            method: 'POST',
            body: JSON.stringify({ action: 'apply-order', order }),
            headers: { 'content-type': 'application/json' },
          }));
          console.error('PAPER order submission entered UNKNOWN', error instanceof Error ? error.message : 'unknown error');
          return json({ error: 'PAPER_ORDER_UNKNOWN', order }, 502, origin);
        }
      } catch (error) {
        return errorResponse(error, origin, 'RECONCILIATION');
      }
    }

    if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, origin);

    const accountConfigured = Boolean(env.ACCOUNT_CANO && env.ACCOUNT_PRODUCT_CODE);

    if (url.pathname === '/account' || url.pathname === '/account/assets') {
      if (!accountConfigured) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);
      try {
        const adapter = new KISAccountAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE);
        return json(url.pathname === '/account' ? await adapter.getSnapshot() : await adapter.getAccountAssets(), 200, origin);
      } catch (error) {
        return errorResponse(error, origin, url.pathname === '/account' ? 'ACCOUNT' : 'ACCOUNT_ASSET');
      }
    }

    if (url.pathname === '/buyable') {
      if (!accountConfigured) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);
      const symbol = url.searchParams.get('symbol')?.trim() ?? '';
      const priceText = url.searchParams.get('price')?.trim() ?? '';
      const orderType = parseOrderType(url.searchParams.get('orderType'));
      const price = Number(priceText);
      if (!/^\d{6}$/.test(symbol) || !Number.isFinite(price) || price <= 0 || !orderType) {
        return json({ error: 'INVALID_BUYABLE_PARAMS' }, 400, origin);
      }
      try {
        const adapter = new KISAccountAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE);
        return json(await adapter.getBuyable(symbol, price, orderType), 200, origin);
      } catch (error) {
        return errorResponse(error, origin, 'BUYABLE');
      }
    }

    if (url.pathname === '/orders') {
      if (!accountConfigured) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);
      const today = getKstDate();
      const startDate = parseDateParam(url.searchParams.get('startDate'), today);
      const endDate = parseDateParam(url.searchParams.get('endDate'), today);
      if (!/^\d{8}$/.test(startDate) || !/^\d{8}$/.test(endDate) || startDate > endDate) {
        return json({ error: 'INVALID_ORDER_HISTORY_PARAMS' }, 400, origin);
      }
      try {
        const adapter = new KISOrderAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE);
        return json(await adapter.getOrderHistory(startDate, endDate), 200, origin);
      } catch (error) {
        return errorResponse(error, origin, 'ORDERS');
      }
    }

    if (url.pathname === '/reconciliation') {
      if (!accountConfigured) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);
      try {
        const result = await loadReconciliation(env);
        return json({ asOf: new Date().toISOString(), environment: getEnvironment(env), ...result }, 200, origin);
      } catch (error) {
        return errorResponse(error, origin, 'RECONCILIATION');
      }
    }

    if (url.pathname !== '/quote' && url.pathname !== '/quotes') return json({ error: 'NOT_FOUND' }, 404, origin);

    const symbols = url.pathname === '/quote'
      ? parseSymbols(url.searchParams.get('symbol'))
      : parseSymbols(url.searchParams.get('symbols'));
    if (!validateSymbols(symbols)) return json({ error: 'INVALID_SYMBOLS', maxSymbols: QUOTE_MAX_SYMBOLS }, 400, origin);

    try {
      const adapter = new KISQuoteAdapter(createClient(env));
      const quotes = [];
      for (const symbol of symbols) quotes.push(await adapter.getQuote(symbol));
      return json(url.pathname === '/quote' ? quotes[0] : quotes, 200, origin);
    } catch (error) {
      return errorResponse(error, origin, 'QUOTE');
    }
  },
};
