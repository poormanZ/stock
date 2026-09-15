/**
 * 전략 계층. KIS 호출 코드와 분리된 순수 함수만 둔다.
 * 동일 입력에 동일 결과를 내야 하며, 백테스트와 자동 실행이 같은 인터페이스를 사용한다.
 */

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SignalAction = 'buy' | 'sell' | 'hold';

export interface Signal {
  action: SignalAction;
  reason: string;
}

export interface StrategyPosition {
  quantity: number;
  averagePrice: number;
}

export interface StrategyContext {
  symbol: string;
  /** 오래된 순. 마지막 원소가 판단 기준 봉 */
  candles: Candle[];
  position: StrategyPosition | null;
}

export interface Strategy {
  id: string;
  params: Record<string, number>;
  /** 신호를 내기 위해 필요한 최소 봉 수 */
  warmupBars: number;
  evaluate(context: StrategyContext): Signal;
}

export interface StrategySpec {
  id: string;
  params?: Record<string, number>;
}

export interface ExitRules {
  /** 평균단가 대비 손절 비율(%). 0이면 사용하지 않음 */
  stopLossPct: number;
  /** 평균단가 대비 익절 비율(%). 0이면 사용하지 않음 */
  takeProfitPct: number;
}

export interface SizingRules {
  /** 한 번의 진입에 쓸 현금 비율 (0 < x ≤ 1) */
  cashFraction: number;
  maxOrderAmount: number;
  maxOrderQuantity: number;
  maxPositionQuantity: number;
}

export const DEFAULT_EXIT_RULES: ExitRules = { stopLossPct: 5, takeProfitPct: 10 };
export const DEFAULT_SIZING_RULES: SizingRules = { cashFraction: 0.2, maxOrderAmount: 1_000_000, maxOrderQuantity: 1000, maxPositionQuantity: 5000 };

const HOLD: Signal = { action: 'hold', reason: 'NO_SIGNAL' };

export function sma(values: number[], length: number): number | null {
  if (length <= 0 || values.length < length) return null;
  let sum = 0;
  for (let i = values.length - length; i < values.length; i += 1) sum += values[i];
  return sum / length;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 단기 SMA가 장기 SMA를 상향 돌파하면 매수, 하향 돌파하면 매도 */
export function smaCrossoverStrategy(params: Record<string, number> = {}): Strategy {
  const fast = positiveInt(params.fast, 5);
  const slow = positiveInt(params.slow, 20);
  if (fast >= slow) throw new Error('INVALID_STRATEGY_PARAMS:fast<slow');
  return {
    id: 'sma-crossover',
    params: { fast, slow },
    warmupBars: slow + 1,
    evaluate({ candles, position }) {
      const closes = candles.map((candle) => candle.close);
      const fastNow = sma(closes, fast);
      const slowNow = sma(closes, slow);
      const fastPrev = sma(closes.slice(0, -1), fast);
      const slowPrev = sma(closes.slice(0, -1), slow);
      if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) return { action: 'hold', reason: 'WARMUP' };
      const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
      const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;
      if (crossedUp && !position) return { action: 'buy', reason: `SMA${fast}>SMA${slow}` };
      if (crossedDown && position) return { action: 'sell', reason: `SMA${fast}<SMA${slow}` };
      return HOLD;
    },
  };
}

const STRATEGIES: Record<string, (params?: Record<string, number>) => Strategy> = {
  'sma-crossover': smaCrossoverStrategy,
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);

export function createStrategy(spec: StrategySpec): Strategy {
  const factory = STRATEGIES[spec.id];
  if (!factory) throw new Error(`UNKNOWN_STRATEGY:${spec.id}`);
  return factory(spec.params);
}

/** 보유 포지션에 대한 손절/익절 판단. 전략 신호보다 우선한다 */
export function checkExitRules(position: StrategyPosition | null, price: number, rules: ExitRules): Signal | null {
  if (!position || position.quantity <= 0 || position.averagePrice <= 0 || price <= 0) return null;
  const changePct = ((price - position.averagePrice) / position.averagePrice) * 100;
  if (rules.stopLossPct > 0 && changePct <= -rules.stopLossPct) return { action: 'sell', reason: `STOP_LOSS:${changePct.toFixed(2)}%` };
  if (rules.takeProfitPct > 0 && changePct >= rules.takeProfitPct) return { action: 'sell', reason: `TAKE_PROFIT:${changePct.toFixed(2)}%` };
  return null;
}

/**
 * 진입 수량. 현금 비율·주문금액·수량·포지션 한도 중 가장 작은 값을 정수로 내림한다.
 * costBps는 슬리피지·수수료 등 체결가 대비 추가 비용으로, 현금 한도 계산에만 반영한다.
 */
export function sizeEntry(cash: number, price: number, currentQuantity: number, rules: SizingRules, costBps = 0): number {
  if (!(price > 0) || !(cash > 0) || rules.cashFraction <= 0) return 0;
  const effectivePrice = price * (1 + Math.max(0, costBps) / 10_000);
  const byCash = Math.floor((cash * Math.min(rules.cashFraction, 1)) / effectivePrice);
  const byAmount = Math.floor(rules.maxOrderAmount / price);
  const byPosition = rules.maxPositionQuantity - currentQuantity;
  return Math.max(0, Math.min(byCash, byAmount, rules.maxOrderQuantity, byPosition));
}

export function validateExitRules(value: unknown): ExitRules {
  const rules = { ...DEFAULT_EXIT_RULES, ...(value && typeof value === 'object' ? value : {}) } as ExitRules;
  if (![rules.stopLossPct, rules.takeProfitPct].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new Error('INVALID_EXIT_RULES');
  return rules;
}

export function validateSizingRules(value: unknown): SizingRules {
  const rules = { ...DEFAULT_SIZING_RULES, ...(value && typeof value === 'object' ? value : {}) } as SizingRules;
  const values = [rules.cashFraction, rules.maxOrderAmount, rules.maxOrderQuantity, rules.maxPositionQuantity];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) || rules.cashFraction > 1) throw new Error('INVALID_SIZING_RULES');
  return rules;
}
