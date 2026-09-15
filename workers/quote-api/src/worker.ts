import app from './index';
import type { Env } from './env';
import { runTradingCycle } from './trading-engine';

export type { Env as WorkerEnv } from './env';
export { KISTokenBroker } from './kis-token-broker';
export { InternalStateStoreDO } from './internal-state-store';
export { DryRunStateStoreDO } from './dry-run-simulator';
export { RiskStateStoreDO } from './risk-manager';
export { AuditLogStoreDO } from './audit-log';
export { TradingStateStoreDO } from './trading-state';

export default {
  fetch: app.fetch,
  /** Cron Trigger. 엔진이 RUNNING 상태가 아니면 아무 일도 하지 않는다 */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runTradingCycle(env, 'cron').then((result) => {
      if (result.ran) console.log('trading cycle', { id: result.run.id, status: result.run.status, reason: result.run.reason, orders: result.run.orders.length });
    }));
  },
};
