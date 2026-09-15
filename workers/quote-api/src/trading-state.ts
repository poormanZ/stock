import type { ExitRules, SizingRules, StrategySpec } from './strategy';
import { createStrategy, validateExitRules, validateSizingRules } from './strategy';

export type TradingStatus = 'STOPPED' | 'READY' | 'RUNNING' | 'ERROR' | 'EMERGENCY_STOP';
/** 자동 실행은 DRY_RUN 또는 PAPER만 허용한다. LIVE는 스케줄러에서 실행하지 않는다 */
export type TradingMode = 'DRY_RUN' | 'PAPER';

export interface TradingConfig {
  mode: TradingMode;
  symbols: string[];
  strategy: StrategySpec;
  exit: ExitRules;
  sizing: SizingRules;
  /** 전략 평가에 사용할 최근 일봉 수 */
  candleBars: number;
}

export type TradingRunStatus = 'OK' | 'SKIPPED' | 'ERROR';
export type TradingErrorSource = 'DATA' | 'STRATEGY' | 'ORDER' | 'SYSTEM';

export interface TradingRunSignal { symbol: string; action: string; reason: string; price?: number; }
export interface TradingRunOrder { symbol: string; side: 'buy' | 'sell'; quantity: number; clientOrderId: string; status: number | 'ERROR'; result: string; }

export interface TradingRun {
  id: string;
  trigger: 'cron' | 'manual';
  mode: TradingMode;
  startedAt: string;
  finishedAt: string;
  status: TradingRunStatus;
  reason?: string;
  signals: TradingRunSignal[];
  orders: TradingRunOrder[];
  error?: { source: TradingErrorSource; message: string };
}

export interface TradingLease { runId: string; until: string; }

export interface TradingState {
  status: TradingStatus;
  config: TradingConfig | null;
  updatedAt: string;
  lastRun?: TradingRun;
  runs: TradingRun[];
  lease?: TradingLease;
  error?: string;
}

export type TradingCommand =
  | { action: 'configure'; config: unknown }
  | { action: 'start'; config?: unknown }
  | { action: 'stop' }
  | { action: 'acquire-lease'; runId: string; ttlMs: number }
  | { action: 'release-lease'; runId: string }
  | { action: 'record-run'; run: TradingRun; nextStatus?: TradingStatus; error?: string };

export const TRADING_RUN_HISTORY = 50;
const MAX_SYMBOLS = 10;
const MIN_CANDLE_BARS = 30;
const MAX_CANDLE_BARS = 400;
const DEFAULT_CANDLE_BARS = 60;

function emptyState(): TradingState {
  return { status: 'STOPPED', config: null, updatedAt: new Date(0).toISOString(), runs: [] };
}

export function validateTradingConfig(value: unknown): TradingConfig {
  if (!value || typeof value !== 'object') throw new Error('INVALID_TRADING_CONFIG');
  const candidate = value as Partial<TradingConfig>;
  if (candidate.mode !== 'DRY_RUN' && candidate.mode !== 'PAPER') throw new Error('INVALID_TRADING_MODE');
  const symbols = [...new Set(Array.isArray(candidate.symbols) ? candidate.symbols.map((symbol) => String(symbol).trim()) : [])];
  if (symbols.length === 0 || symbols.length > MAX_SYMBOLS || !symbols.every((symbol) => /^\d{6}$/.test(symbol))) throw new Error('INVALID_TRADING_SYMBOLS');
  if (!candidate.strategy || typeof candidate.strategy !== 'object' || typeof candidate.strategy.id !== 'string') throw new Error('STRATEGY_REQUIRED');
  const strategy = createStrategy(candidate.strategy);
  const candleBars = candidate.candleBars ?? DEFAULT_CANDLE_BARS;
  if (!Number.isInteger(candleBars) || candleBars < MIN_CANDLE_BARS || candleBars > MAX_CANDLE_BARS) throw new Error('INVALID_CANDLE_BARS');
  if (candleBars < strategy.warmupBars) throw new Error('CANDLE_BARS_BELOW_WARMUP');
  return {
    mode: candidate.mode,
    symbols,
    strategy: { id: strategy.id, params: strategy.params },
    exit: validateExitRules(candidate.exit),
    sizing: validateSizingRules(candidate.sizing),
    candleBars,
  };
}

/** 자동매매 실행 상태·설정·실행 이력·중복 실행 방지 lease를 한 DO에 보관한다 */
export class TradingStateStoreDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const current = (await this.state.storage.get<TradingState>('state')) ?? emptyState();
    if (request.method === 'GET') return Response.json(current, { headers: { 'cache-control': 'no-store' } });
    if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });

    const body = await request.json().catch(() => null) as TradingCommand | null;
    if (!body || typeof body !== 'object') return Response.json({ error: 'INVALID_TRADING_COMMAND' }, { status: 400 });
    const now = new Date();

    try {
      switch (body.action) {
        case 'configure': {
          if (current.status === 'RUNNING') return Response.json({ error: 'TRADING_RUNNING', status: current.status }, { status: 409 });
          return this.persist({ ...current, config: validateTradingConfig(body.config), status: 'READY', error: undefined }, now);
        }
        case 'start': {
          const config = body.config !== undefined ? validateTradingConfig(body.config) : current.config;
          if (!config) return Response.json({ error: 'TRADING_NOT_CONFIGURED' }, { status: 409 });
          if (current.status === 'EMERGENCY_STOP') return Response.json({ error: 'EMERGENCY_STOP_ACTIVE', status: current.status }, { status: 409 });
          return this.persist({ ...current, config, status: 'RUNNING', error: undefined }, now);
        }
        case 'stop':
          return this.persist({ ...current, status: 'STOPPED', lease: undefined }, now);
        case 'acquire-lease': {
          if (typeof body.runId !== 'string' || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) return Response.json({ error: 'INVALID_LEASE_REQUEST' }, { status: 400 });
          const held = current.lease && Date.parse(current.lease.until) > now.getTime() && current.lease.runId !== body.runId;
          if (held) return Response.json({ acquired: false, lease: current.lease });
          const lease: TradingLease = { runId: body.runId, until: new Date(now.getTime() + body.ttlMs).toISOString() };
          await this.state.storage.put('state', { ...current, lease, updatedAt: now.toISOString() });
          return Response.json({ acquired: true, lease });
        }
        case 'release-lease': {
          if (current.lease?.runId !== body.runId) return Response.json({ released: false });
          await this.state.storage.put('state', { ...current, lease: undefined, updatedAt: now.toISOString() });
          return Response.json({ released: true });
        }
        case 'record-run': {
          if (!body.run || typeof body.run !== 'object') return Response.json({ error: 'INVALID_RUN' }, { status: 400 });
          const runs = [...current.runs, body.run].slice(-TRADING_RUN_HISTORY);
          const status = body.nextStatus ?? current.status;
          return this.persist({ ...current, runs, lastRun: body.run, status, error: body.error ?? (status === current.status ? current.error : undefined) }, now);
        }
        default:
          return Response.json({ error: 'INVALID_TRADING_COMMAND' }, { status: 400 });
      }
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'INVALID_TRADING_CONFIG' }, { status: 400 });
    }
  }

  private async persist(state: TradingState, now: Date): Promise<Response> {
    const next = { ...state, updatedAt: now.toISOString() };
    await this.state.storage.put('state', next);
    return Response.json(next);
  }
}
