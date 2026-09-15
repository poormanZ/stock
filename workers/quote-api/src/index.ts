import { sendAlert } from './alerts';
import { handleAuditLog } from './audit-routes';
import { handleDryRunOrder, handleDryRunReset, handleDryRunState } from './dry-run-routes';
import type { Env } from './env';
import { errorMessage, json, noContent, type RouteHandler } from './http';
import { handleLiveArm, handleLiveCancel, handleLiveDisarm, handleLiveOrder, handleLiveStatus } from './live-routes';
import { handlePaperCancel, handlePaperOrder, handlePaperPositionSync, handlePaperReconcile } from './paper-routes';
import { handleAccount, handleBuyable, handleOrders, handleQuotes, handleReconciliation } from './query-routes';
import { handleKillSwitch, handleRiskState } from './risk-routes';
import { appendAudit } from './state-clients';
import { handleBacktest, handleCandles, handleStrategies } from './strategy-routes';
import { handleTradingConfigure, handleTradingRun, handleTradingRuns, handleTradingStart, handleTradingStatus, handleTradingStop } from './trading-routes';

const routes: Record<string, RouteHandler> = {
  'GET /quote': handleQuotes,
  'GET /quotes': handleQuotes,
  'GET /account': handleAccount,
  'GET /account/assets': handleAccount,
  'GET /buyable': handleBuyable,
  'GET /orders': handleOrders,
  'GET /reconciliation': handleReconciliation,
  'GET /audit': handleAuditLog,
  'GET /candles': handleCandles,
  'GET /strategies': handleStrategies,
  'POST /backtest': handleBacktest,
  'GET /trading/status': handleTradingStatus,
  'GET /trading/runs': handleTradingRuns,
  'POST /trading/configure': handleTradingConfigure,
  'POST /trading/start': handleTradingStart,
  'POST /trading/stop': handleTradingStop,
  'POST /trading/run': handleTradingRun,
  'GET /risk': handleRiskState,
  'POST /risk/kill-switch': handleKillSwitch,
  'GET /dry-run': handleDryRunState,
  'POST /dry-run/orders': handleDryRunOrder,
  'POST /dry-run/reset': handleDryRunReset,
  'POST /paper/orders': handlePaperOrder,
  'POST /paper/orders/cancel': handlePaperCancel,
  'POST /paper/position-sync': handlePaperPositionSync,
  'POST /paper/reconcile': handlePaperReconcile,
  'GET /live/status': handleLiveStatus,
  'POST /live/arm': handleLiveArm,
  'POST /live/disarm': handleLiveDisarm,
  'POST /live/orders': handleLiveOrder,
  'POST /live/orders/cancel': handleLiveCancel,
};

const knownPaths = new Set(Object.keys(routes).map((key) => key.split(' ')[1]));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') return noContent(origin);

    const url = new URL(request.url);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) {
      return knownPaths.has(url.pathname)
        ? json({ error: 'METHOD_NOT_ALLOWED' }, 405, origin)
        : json({ error: 'NOT_FOUND' }, 404, origin);
    }

    try {
      return await handler({ request, env, url, origin });
    } catch (error) {
      // 처리되지 않은 예외도 CORS 헤더가 있는 JSON으로 돌려 브라우저가 원인을 볼 수 있게 한다
      const message = `${request.method} ${url.pathname} failed: ${errorMessage(error)}`;
      console.error(message);
      await appendAudit(env, { type: 'SYSTEM_ERROR', mode: 'SYSTEM', message });
      await sendAlert(env, { level: 'ERROR', title: 'SYSTEM_ERROR', message });
      return json({ error: 'INTERNAL_ERROR' }, 500, origin);
    }
  },
};
