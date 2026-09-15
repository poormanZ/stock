import { runBacktest } from './backtest';
import { DEFAULT_DRY_RUN_CASH } from './dry-run-simulator';
import { createCandleAdapter } from './env';
import { errorMessage, errorResponse, json, type RouteContext } from './http';
import { isYyyymmdd, shiftYyyymmdd } from './kis-candle-adapter';
import { todayKst } from './kis-common';
import { createStrategy, DEFAULT_EXIT_RULES, STRATEGY_IDS, STRATEGY_INFOS, validateExitRules, validateSizingRules, type StrategySpec } from './strategy';

/** 한 번의 조회/백테스트 범위 상한. KIS 100건 페이지 × 10페이지 이내로 제한한다 */
const MAX_RANGE_DAYS = 1000;

function parseRange(startDate: string | undefined, endDate: string | undefined): { startDate: string; endDate: string } | null {
  const end = endDate || todayKst();
  const start = startDate || shiftYyyymmdd(end, -365);
  if (!isYyyymmdd(start) || !isYyyymmdd(end) || start > end || shiftYyyymmdd(start, MAX_RANGE_DAYS) < end) return null;
  return { startDate: start, endDate: end };
}

export async function handleCandles({ url, env, origin }: RouteContext): Promise<Response> {
  const symbol = url.searchParams.get('symbol')?.trim() ?? '';
  const range = parseRange(url.searchParams.get('startDate')?.trim(), url.searchParams.get('endDate')?.trim());
  if (!/^\d{6}$/.test(symbol) || !range) return json({ error: 'INVALID_CANDLE_PARAMS', maxRangeDays: MAX_RANGE_DAYS }, 400, origin);
  try {
    const candles = await createCandleAdapter(env).getDailyCandles(symbol, range.startDate, range.endDate);
    return json({ symbol, ...range, interval: 'D', count: candles.length, candles }, 200, origin);
  } catch (error) {
    return errorResponse(error, origin, 'QUOTE');
  }
}

export async function handleStrategies({ origin }: RouteContext): Promise<Response> {
  return json({ strategies: STRATEGY_IDS, details: STRATEGY_INFOS, defaultExit: DEFAULT_EXIT_RULES }, 200, origin);
}

/**
 * 과거 일봉으로 전략을 검증한다. 결과는 DRY_RUN 비용 모델 기준 시뮬레이션이며 실거래 성과가 아니다.
 */
export async function handleBacktest({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null) as {
    symbol?: string; startDate?: string; endDate?: string; strategy?: StrategySpec;
    initialCash?: number; exit?: unknown; sizing?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_BACKTEST_REQUEST' }, 400, origin);
  const symbol = body.symbol?.trim() ?? '';
  const range = parseRange(body.startDate, body.endDate);
  if (!/^\d{6}$/.test(symbol) || !range) return json({ error: 'INVALID_BACKTEST_REQUEST', maxRangeDays: MAX_RANGE_DAYS }, 400, origin);
  if (!body.strategy || typeof body.strategy.id !== 'string') return json({ error: 'STRATEGY_REQUIRED', strategies: STRATEGY_IDS }, 400, origin);
  const initialCash = body.initialCash ?? DEFAULT_DRY_RUN_CASH;
  if (typeof initialCash !== 'number' || !Number.isFinite(initialCash) || initialCash <= 0) return json({ error: 'INVALID_INITIAL_CASH' }, 400, origin);

  let strategy;
  let exit;
  let sizing;
  try {
    strategy = createStrategy(body.strategy);
    exit = validateExitRules(body.exit);
    sizing = validateSizingRules(body.sizing);
  } catch (error) {
    return json({ error: 'INVALID_BACKTEST_CONFIG', reason: errorMessage(error) }, 400, origin);
  }

  try {
    const candles = await createCandleAdapter(env).getDailyCandles(symbol, range.startDate, range.endDate);
    if (candles.length < strategy.warmupBars + 1) {
      return json({ error: 'INSUFFICIENT_CANDLES', required: strategy.warmupBars + 1, received: candles.length }, 409, origin);
    }
    const result = runBacktest({ symbol, candles, strategy, initialCash, exit, sizing });
    return json({ disclaimer: 'DRY_RUN 비용 모델 기준 시뮬레이션 결과이며 실거래 성과를 보장하지 않습니다.', exit, sizing, ...result }, 200, origin);
  } catch (error) {
    return errorResponse(error, origin, 'QUOTE');
  }
}
