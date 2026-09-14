import app from './index';
import { KISAccountAdapter } from './kis-account-adapter';
import { KISHttpClient, KISHttpError } from './kis-http-client';
import { KISOrderAdapter } from './kis-order-adapter';
import { KISPaperOrderAdapter } from './kis-paper-order-adapter';
import { KISTokenBroker } from './kis-token-broker';
import { InternalStateStoreDO } from './internal-state-store';
import { resyncPaperOrders } from './paper-order-reconciliation';
import { getMarketSession } from './market-session';
import { transitionOrder, type Order } from './order-domain';

export { KISTokenBroker } from './kis-token-broker';
export { InternalStateStoreDO } from './internal-state-store';
export { DryRunStateStoreDO } from './dry-run-simulator';
export { RiskStateStoreDO } from './risk-manager';

export type WorkerEnv = Parameters<typeof app.fetch>[1];

type KISEnvironment = 'PAPER' | 'LIVE';

function getEnvironment(env: WorkerEnv): KISEnvironment {
  return env.KIS_ENVIRONMENT === 'LIVE' ? 'LIVE' : 'PAPER';
}

function createClient(env: WorkerEnv): KISHttpClient {
  return new KISHttpClient({
    appKey: env.APP_KEY,
    appSecret: env.APP_SECRET,
    environment: getEnvironment(env),
    baseUrl: env.KIS_BASE_URL,
    tokenCache: env.KIS_TOKEN_CACHE,
    tokenBroker: env.KIS_TOKEN_BROKER,
  });
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

function reconcileError(error: unknown, origin: string): Response {
  if (error instanceof KISHttpError) {
    const status = error.code === 'KIS_TIMEOUT' ? 504 : error.code === 'KIS_RATE_LIMITED' ? 429 : 502;
    const body: Record<string, unknown> = { error: error.code };
    if (error.status !== undefined) body.status = error.status;
    if (error.upstreamCode) body.code = error.upstreamCode;
    if (error.message) body.message = error.message.slice(0, 300);
    return json(body, status, origin);
  }
  if (error instanceof Error && error.message === 'INTERNAL_STATE_UNAVAILABLE') {
    return json({ error: 'RECONCILIATION_UNAVAILABLE', message: error.message }, 503, origin);
  }
  return json({ error: 'RECONCILIATION_UNAVAILABLE', message: error instanceof Error ? error.message.slice(0, 300) : 'unknown error' }, 502, origin);
}

async function handlePaperReconcile(env: WorkerEnv, origin: string): Promise<Response> {
  if (getEnvironment(env) !== 'PAPER') return json({ error: 'PAPER_ENVIRONMENT_REQUIRED' }, 409, origin);
  if (!env.ACCOUNT_CANO || !env.ACCOUNT_PRODUCT_CODE) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);

  try {
    const internalId = env.INTERNAL_STATE_STORE.idFromName('primary');
    const internalStore = env.INTERNAL_STATE_STORE.get(internalId);
    const internalResponse = await internalStore.fetch('https://internal-state/');
    if (!internalResponse.ok) throw new Error('INTERNAL_STATE_UNAVAILABLE');

    const internalState = (await internalResponse.json()) as {
      positions: { symbol: string; quantity: number }[];
      orders: { brokerOrderId: string; status: string; symbol: string; side: 'buy' | 'sell' | 'unknown'; quantity: number; executedQuantity: number }[];
      orderRecords?: Order[];
    };

    const [account, brokerHistory] = await Promise.all([
      new KISAccountAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE).getSnapshot(),
      new KISOrderAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE).getOrderHistory(getKstDate(), getKstDate()),
    ]);

    const internalOrders = internalState.orderRecords ?? [];
    const result = resyncPaperOrders(internalOrders, brokerHistory.orders);
    const changedOrders = result.orders.filter((order, index) => order.updatedAt !== internalOrders[index]?.updatedAt);

    for (const order of changedOrders) {
      const persistResponse = await internalStore.fetch(new Request('https://internal-state/', {
        method: 'POST',
        body: JSON.stringify({ action: 'apply-order', order }),
        headers: { 'content-type': 'application/json' },
      }));
      if (!persistResponse.ok) throw new Error('INTERNAL_STATE_UNAVAILABLE');
    }

    return json({
      asOf: new Date().toISOString(),
      environment: getEnvironment(env),
      account,
      updated: result.updated,
      unresolved: result.unresolved,
      orders: result.orders,
    }, 200, origin);
  } catch (error) {
    return reconcileError(error, origin);
  }
}

async function handlePaperCancel(env: WorkerEnv, request: Request, origin: string): Promise<Response> {
  if (getEnvironment(env) !== 'PAPER') return json({ error: 'PAPER_ENVIRONMENT_REQUIRED' }, 409, origin);
  if (!env.ACCOUNT_CANO || !env.ACCOUNT_PRODUCT_CODE) return json({ error: 'ACCOUNT_NOT_CONFIGURED' }, 503, origin);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_PAPER_CANCEL_REQUEST' }, 400, origin);
  const candidate = body as { id?: string; clientOrderId?: string };
  if (!candidate.id && !candidate.clientOrderId) return json({ error: 'ORDER_IDENTIFIER_REQUIRED' }, 400, origin);

  try {
    const internalId = env.INTERNAL_STATE_STORE.idFromName('primary');
    const internalStore = env.INTERNAL_STATE_STORE.get(internalId);
    const internalResponse = await internalStore.fetch('https://internal-state/');
    if (!internalResponse.ok) throw new Error('INTERNAL_STATE_UNAVAILABLE');
    const internalState = (await internalResponse.json()) as { orderRecords?: Order[] };
    const order = (internalState.orderRecords ?? []).find((item) => candidate.id === item.id || candidate.clientOrderId === item.clientOrderId);
    if (!order) return json({ error: 'ORDER_NOT_FOUND' }, 404, origin);
    if (!['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED'].includes(order.status)) {
      return json({ error: 'ORDER_NOT_CANCELLABLE', status: order.status, order }, 409, origin);
    }

    const cancellation = await new KISPaperOrderAdapter(
      createClient(env),
      getEnvironment(env),
      env.ACCOUNT_CANO,
      env.ACCOUNT_PRODUCT_CODE,
    ).cancel(order);

    if (!cancellation.accepted) {
      return json({ error: 'PAPER_ORDER_CANCEL_REJECTED', code: cancellation.messageCode, message: cancellation.message, order }, 409, origin);
    }

    const canceledOrder = transitionOrder(order, 'CANCELED');
    const persistResponse = await internalStore.fetch(new Request('https://internal-state/', {
      method: 'POST',
      body: JSON.stringify({ action: 'apply-order', order: canceledOrder }),
      headers: { 'content-type': 'application/json' },
    }));
    if (!persistResponse.ok) throw new Error('INTERNAL_STATE_UNAVAILABLE');

    return json({ order: canceledOrder, messageCode: cancellation.messageCode, message: cancellation.message }, 200, origin);
  } catch (error) {
    if (error instanceof KISHttpError) return reconcileError(error, origin);
    if (error instanceof Error && error.message === 'INTERNAL_STATE_UNAVAILABLE') return reconcileError(error, origin);
    return json({ error: 'PAPER_ORDER_CANCEL_UNKNOWN', message: error instanceof Error ? error.message.slice(0, 300) : 'unknown error' }, 502, origin);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || '*';

    if (url.pathname === '/paper/reconcile' && request.method === 'POST') {
      return handlePaperReconcile(env, origin);
    }

    if (url.pathname === '/paper/orders/cancel' && request.method === 'POST') {
      if (getEnvironment(env) === 'PAPER') {
        const session = getMarketSession();
        if (!session.isOpen) {
          return json({
            error: 'MARKET_SESSION_CLOSED',
            status: session.status,
            asOf: session.asOf,
            timeZone: session.timeZone,
          }, 409, origin);
        }
      }
      return handlePaperCancel(env, request, origin);
    }

    if (url.pathname === '/paper/orders' && request.method === 'POST' && getEnvironment(env) === 'PAPER') {
      const session = getMarketSession();
      if (!session.isOpen) {
        return json({
          error: 'MARKET_SESSION_CLOSED',
          status: session.status,
          asOf: session.asOf,
          timeZone: session.timeZone,
        }, 409, origin);
      }
    }

    return app.fetch(request, env);
  },
};
