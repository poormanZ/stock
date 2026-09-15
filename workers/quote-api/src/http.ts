import type { Env } from './env';
import { KISAccountConfigError, KISRejectedError, type KISOperation } from './kis-common';
import { KISHttpError } from './kis-http-client';
import { INTERNAL_STATE_UNAVAILABLE } from './state-clients';

export interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  origin: string;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response>;

export type ErrorScope = 'QUOTE' | 'ACCOUNT' | 'ACCOUNT_ASSET' | 'BUYABLE' | 'ORDERS' | 'RECONCILIATION' | 'POSITION_SYNC';

const UNAVAILABLE_CODE: Record<ErrorScope, string> = {
  QUOTE: 'QUOTE_UNAVAILABLE',
  ACCOUNT: 'ACCOUNT_UNAVAILABLE',
  ACCOUNT_ASSET: 'ACCOUNT_ASSET_UNAVAILABLE',
  BUYABLE: 'BUYABLE_UNAVAILABLE',
  ORDERS: 'ORDERS_UNAVAILABLE',
  RECONCILIATION: 'RECONCILIATION_UNAVAILABLE',
  POSITION_SYNC: 'POSITION_SYNC_UNAVAILABLE',
};

const REJECTED_CODE: Record<KISOperation, string> = {
  balance: 'KIS_ACCOUNT_REJECTED',
  'account asset': 'KIS_ACCOUNT_ASSET_REJECTED',
  buyable: 'KIS_BUYABLE_REJECTED',
  'order history': 'KIS_ORDER_HISTORY_REJECTED',
  'period trade profit': 'KIS_PERIOD_TRADE_PROFIT_REJECTED',
};

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

export function json(data: unknown, status = 200, origin = '*'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

/** preflight 응답. 204는 body를 가질 수 없으므로 null body로 만든다 */
export function noContent(origin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/** DO 등 내부 응답을 브라우저로 그대로 전달할 때 CORS/캐시 헤더를 덧붙인다 */
export function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

export function errorMessage(error: unknown, fallback = 'unknown error'): string {
  return error instanceof Error ? error.message.slice(0, 300) : fallback;
}

export function errorResponse(error: unknown, origin: string, scope: ErrorScope): Response {
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
  if (error instanceof KISAccountConfigError) return json({ error: 'ACCOUNT_CONFIG_INVALID' }, 503, origin);
  if (error instanceof KISRejectedError) {
    return json({ error: REJECTED_CODE[error.operation], code: error.code, message: error.detail }, 502, origin);
  }
  if (error instanceof Error && error.message === INTERNAL_STATE_UNAVAILABLE) {
    return json({ error: UNAVAILABLE_CODE[scope], message: error.message }, 503, origin);
  }
  console.error(`${scope} request failed`, errorMessage(error));
  return json({ error: UNAVAILABLE_CODE[scope], message: errorMessage(error) }, 502, origin);
}
