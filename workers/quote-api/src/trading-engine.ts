import { sendAlert, type Alert } from './alerts';
import type { AuditEventInput } from './audit-log';
import { DEFAULT_DRY_RUN_CONFIG } from './dry-run-simulator';
import { placeDryRunOrder } from './dry-run-routes';
import { createAccountAdapter, createCandleAdapter, createQuoteAdapter, getEnvironment, type Env } from './env';
import { errorMessage } from './http';
import { shiftYyyymmdd } from './kis-candle-adapter';
import { todayKst } from './kis-common';
import { getMarketSession, type MarketSession } from './market-session';
import type { CreateOrderRequest } from './order-domain';
import { paperPrecheck, placePaperOrder, resyncPaperOrdersWithKis } from './paper-routes';
import { acquireTradingLease, appendAudit, readDryRunState, readInternalState, readKillSwitch, readTradingState, recordTradingRun, releaseTradingLease } from './state-clients';
import { checkExitRules, createStrategy, sizeEntry, type Candle, type Signal, type StrategyPosition } from './strategy';
import type { TradingErrorSource, TradingMode, TradingRun, TradingRunOrder, TradingRunSignal, TradingState, TradingStatus } from './trading-state';

export interface Portfolio {
  cash: number;
  positions: (StrategyPosition & { symbol: string })[];
}

export interface OrderPlacement {
  status: number | 'ERROR';
  body: Record<string, unknown>;
}

/** 엔진이 외부 세계와 닿는 지점. 테스트에서는 stub으로 교체한다 */
export interface TradingDeps {
  now(): Date;
  readState(): Promise<TradingState>;
  acquireLease(runId: string, ttlMs: number): Promise<boolean>;
  releaseLease(runId: string): Promise<void>;
  recordRun(run: TradingRun, nextStatus?: TradingStatus, error?: string): Promise<void>;
  readKillSwitch(): Promise<{ active: boolean }>;
  marketSession(now: Date): MarketSession;
  getCandles(symbol: string, startDate: string, endDate: string): Promise<Candle[]>;
  getPrice(symbol: string): Promise<number>;
  readPortfolio(mode: TradingMode): Promise<Portfolio>;
  placeOrder(mode: TradingMode, request: CreateOrderRequest, referencePrice: number): Promise<OrderPlacement>;
  resyncPaper(): Promise<void>;
  audit(event: AuditEventInput): Promise<void>;
  alert(alert: Alert): Promise<void>;
}

export type TradingCycleResult =
  | { ran: false; reason: 'NOT_RUNNING' | 'LEASE_HELD' }
  | { ran: true; run: TradingRun };

const LEASE_TTL_MS = 120_000;
/** 영업일 N개를 확보하기 위한 달력일 여유 (주말·휴장일) */
const CALENDAR_DAYS_PER_BAR = 1.6;

class TradingError extends Error {
  constructor(public readonly source: TradingErrorSource, message: string) {
    super(message);
    this.name = 'TradingError';
  }
}

function wrap(source: TradingErrorSource, error: unknown): TradingError {
  return error instanceof TradingError ? error : new TradingError(source, errorMessage(error));
}

export function createDefaultDeps(env: Env): TradingDeps {
  return {
    now: () => new Date(),
    readState: () => readTradingState(env),
    acquireLease: (runId, ttlMs) => acquireTradingLease(env, runId, ttlMs),
    releaseLease: (runId) => releaseTradingLease(env, runId),
    recordRun: (run, nextStatus, error) => recordTradingRun(env, run, nextStatus, error),
    readKillSwitch: () => readKillSwitch(env),
    marketSession: (now) => getMarketSession(now),
    getCandles: (symbol, startDate, endDate) => createCandleAdapter(env).getDailyCandles(symbol, startDate, endDate),
    getPrice: async (symbol) => (await createQuoteAdapter(env).getQuote(symbol)).price,
    readPortfolio: async (mode) => {
      if (mode === 'DRY_RUN') {
        const state = await readDryRunState(env);
        return { cash: state.cash, positions: state.positions };
      }
      const [internal, account] = await Promise.all([readInternalState(env), createAccountAdapter(env).getSnapshot()]);
      return { cash: account.cash, positions: internal.positions.map((position) => ({ symbol: position.symbol, quantity: position.quantity, averagePrice: position.averagePrice ?? 0 })) };
    },
    placeOrder: async (mode, request, referencePrice) => {
      if (mode === 'DRY_RUN') return placeDryRunOrder(env, { request, referencePrice }, 'SCHEDULER');
      const blocked = paperPrecheck(env, true);
      if (blocked) {
        const { status, ...body } = blocked;
        return { status, body };
      }
      const outcome = await placePaperOrder(env, request, referencePrice, 'SCHEDULER');
      if (outcome.status === 'ERROR') throw outcome.error;
      return { status: outcome.status, body: outcome.body };
    },
    resyncPaper: async () => {
      if (getEnvironment(env) !== 'PAPER') return;
      await resyncPaperOrdersWithKis(env, 'SCHEDULER');
    },
    audit: (event) => appendAudit(env, event),
    alert: (alert) => sendAlert(env, alert).then(() => undefined),
  };
}

/** 같은 날 같은 종목·방향 주문은 하나만 낸다. cron 재실행·재시작 시 중복 진입을 막는 멱등 키 */
export function autoClientOrderId(mode: TradingMode, date: string, symbol: string, side: 'buy' | 'sell'): string {
  return `AUTO-${mode}-${date}-${symbol}-${side.toUpperCase()}`;
}

/**
 * 자동매매 한 사이클. RUNNING 상태에서만 동작하며, Kill Switch → EMERGENCY_STOP, 오류 → ERROR로 전이한다.
 * 오류 이후에는 운영자가 원인을 확인하고 다시 start 해야 한다 (fail-safe).
 */
export async function runTradingCycle(env: Env, trigger: 'cron' | 'manual', deps: TradingDeps = createDefaultDeps(env)): Promise<TradingCycleResult> {
  const state = await deps.readState();
  if (state.status !== 'RUNNING' || !state.config) return { ran: false, reason: 'NOT_RUNNING' };
  const config = state.config;
  const startedAt = deps.now();
  const runId = crypto.randomUUID();
  const base = { id: runId, trigger, mode: config.mode, startedAt: startedAt.toISOString() };
  const finish = (partial: Omit<TradingRun, 'id' | 'trigger' | 'mode' | 'startedAt' | 'finishedAt'>): TradingRun => ({ ...base, finishedAt: deps.now().toISOString(), ...partial });

  const killSwitch = await deps.readKillSwitch();
  if (killSwitch.active) {
    const run = finish({ status: 'SKIPPED', reason: 'KILL_SWITCH_ACTIVE', signals: [], orders: [] });
    await deps.recordRun(run, 'EMERGENCY_STOP', 'kill switch active');
    await deps.audit({ type: 'EMERGENCY_STOP', mode: config.mode, message: 'trading cycle halted: kill switch active' });
    await deps.alert({ level: 'CRITICAL', title: 'TRADING_EMERGENCY_STOP', message: `trading engine stopped by kill switch (${config.mode})` });
    return { ran: true, run };
  }

  if (!(await deps.acquireLease(runId, LEASE_TTL_MS))) return { ran: false, reason: 'LEASE_HELD' };

  const signals: TradingRunSignal[] = [];
  const orders: TradingRunOrder[] = [];
  try {
    if (config.mode === 'PAPER' && !deps.marketSession(startedAt).isOpen) {
      const run = finish({ status: 'SKIPPED', reason: 'MARKET_CLOSED', signals, orders });
      await deps.recordRun(run);
      return { ran: true, run };
    }

    let strategy;
    try {
      strategy = createStrategy(config.strategy);
    } catch (error) {
      throw wrap('STRATEGY', error);
    }

    if (config.mode === 'PAPER') {
      try {
        await deps.resyncPaper();
      } catch (error) {
        throw wrap('DATA', error);
      }
    }

    let portfolio: Portfolio;
    try {
      portfolio = await deps.readPortfolio(config.mode);
    } catch (error) {
      throw wrap('DATA', error);
    }
    const today = todayKst();
    const startDate = shiftYyyymmdd(today, -Math.ceil(config.candleBars * CALENDAR_DAYS_PER_BAR) - 7);
    const costBps = DEFAULT_DRY_RUN_CONFIG.slippageBps + DEFAULT_DRY_RUN_CONFIG.feeBps;

    for (const symbol of config.symbols) {
      let candles: Candle[];
      let price: number;
      try {
        [candles, price] = await Promise.all([deps.getCandles(symbol, startDate, today), deps.getPrice(symbol)]);
      } catch (error) {
        throw wrap('DATA', error);
      }
      candles = candles.slice(-config.candleBars);
      if (candles.length < strategy.warmupBars || !(price > 0)) {
        signals.push({ symbol, action: 'hold', reason: candles.length < strategy.warmupBars ? 'INSUFFICIENT_CANDLES' : 'INVALID_PRICE', price });
        continue;
      }

      const held = portfolio.positions.find((position) => position.symbol === symbol && position.quantity > 0) ?? null;
      let signal: Signal;
      try {
        signal = checkExitRules(held, price, config.exit) ?? strategy.evaluate({ symbol, candles, position: held });
      } catch (error) {
        throw wrap('STRATEGY', error);
      }
      signals.push({ symbol, action: signal.action, reason: signal.reason, price });
      if (signal.action === 'hold') continue;
      await deps.audit({ type: 'STRATEGY_SIGNAL', mode: config.mode, symbol, message: `${signal.action} ${symbol} @ ${price}: ${signal.reason}` });

      const quantity = signal.action === 'buy' ? sizeEntry(portfolio.cash, price, 0, config.sizing, costBps) : held?.quantity ?? 0;
      if (quantity <= 0) {
        signals[signals.length - 1].reason += ' (NO_SIZE)';
        continue;
      }
      const clientOrderId = autoClientOrderId(config.mode, today, symbol, signal.action);
      const request: CreateOrderRequest = { id: crypto.randomUUID(), clientOrderId, symbol, side: signal.action, orderType: 'market', quantity };

      let placement: OrderPlacement;
      try {
        placement = await deps.placeOrder(config.mode, request, price);
      } catch (error) {
        orders.push({ symbol, side: signal.action, quantity, clientOrderId, status: 'ERROR', result: errorMessage(error) });
        throw wrap('ORDER', error);
      }
      const result = placement.body.idempotent ? 'ALREADY_PLACED' : String(placement.body.error ?? (placement.body.order as { status?: string } | undefined)?.status ?? placement.status);
      orders.push({ symbol, side: signal.action, quantity, clientOrderId, status: placement.status, result });
      if (placement.status === 200 && !placement.body.idempotent && signal.action === 'buy') {
        portfolio.cash -= quantity * price * (1 + costBps / 10_000);
      }
    }

    const run = finish({ status: 'OK', signals, orders });
    await deps.recordRun(run);
    await deps.audit({ type: 'SCHEDULER_RUN', mode: config.mode, message: `${trigger} cycle ok: ${signals.filter((signal) => signal.action !== 'hold').length} signals, ${orders.length} orders` });
    return { ran: true, run };
  } catch (error) {
    const failure = wrap('SYSTEM', error);
    const run = finish({ status: 'ERROR', signals, orders, error: { source: failure.source, message: failure.message } });
    await deps.recordRun(run, 'ERROR', `${failure.source}: ${failure.message}`);
    await deps.audit({ type: 'SYSTEM_ERROR', mode: config.mode, message: `trading cycle failed [${failure.source}]: ${failure.message}` });
    await deps.alert({ level: 'ERROR', title: 'TRADING_CYCLE_FAILED', message: `[${failure.source}] ${failure.message}` });
    return { ran: true, run };
  } finally {
    await deps.releaseLease(runId);
  }
}
