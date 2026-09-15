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
  /**
   * 신호 봉 안에서 즉시 체결을 가정할 가격(예: 돌파 가격, 당일 시가). 백테스트가 이 가격으로 해당 봉에서 체결한다.
   * 없으면 다음 봉 시가 체결. 자동 실행 엔진은 항상 현재가 시장가로 주문하므로 이 값을 쓰지 않는다.
   */
  price?: number;
}

export interface StrategyPosition {
  quantity: number;
  averagePrice: number;
  /** 진입 봉 날짜(YYYYMMDD, KST). 보유 기간 기반 규칙과 트레일링 스탑에 사용 */
  entryDate?: string;
}

export interface StrategyContext {
  symbol: string;
  /** 오래된 순. 마지막 원소가 판단 기준 봉(장중에는 현재가가 close) */
  candles: Candle[];
  position: StrategyPosition | null;
  /**
   * 마지막 봉이 진행 중인 당일 봉인지(자동 실행). 백테스트는 false.
   * 장중 돌파 판단은 현재가(close)로, 일봉 백테스트는 고가로 해야 종가를 미리 아는 편향이 생기지 않는다.
   */
  intraday?: boolean;
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

export interface StrategyInfo {
  id: string;
  label: string;
  description: string;
  defaultParams: Record<string, number>;
}

export interface ExitRules {
  /** 평균단가 대비 손절 비율(%). 0이면 사용하지 않음 */
  stopLossPct: number;
  /** 평균단가 대비 익절 비율(%). 0이면 사용하지 않음 */
  takeProfitPct: number;
  /** 진입 후 최고 종가 대비 하락 비율(%)로 청산. 0이면 사용하지 않음 */
  trailingStopPct: number;
}

export interface SizingRules {
  /** 한 번의 진입에 쓸 현금 비율 (0 < x ≤ 1) */
  cashFraction: number;
  maxOrderAmount: number;
  maxOrderQuantity: number;
  maxPositionQuantity: number;
}

/**
 * 기본 청산 규칙. 2024-10~2026-09 6종목 백테스트에서 고정 익절(10%)이 추세를 잘라 수익을 거의 없앴고,
 * 손절 7% + 트레일링 10%가 세 구간(전체/전반/후반) 모두에서 가장 일관됐다. docs/trading.md §9 참고.
 */
export const DEFAULT_EXIT_RULES: ExitRules = { stopLossPct: 7, takeProfitPct: 0, trailingStopPct: 10 };
export const DEFAULT_SIZING_RULES: SizingRules = { cashFraction: 0.2, maxOrderAmount: 1_000_000, maxOrderQuantity: 1000, maxPositionQuantity: 5000 };

const HOLD: Signal = { action: 'hold', reason: 'NO_SIGNAL' };
const WARMUP: Signal = { action: 'hold', reason: 'WARMUP' };

export function sma(values: number[], length: number): number | null {
  if (length <= 0 || values.length < length) return null;
  let sum = 0;
  for (let i = values.length - length; i < values.length; i += 1) sum += values[i];
  return sum / length;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 0은 "사용 안 함"을 뜻하는 정수 파라미터 */
function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number, max = Number.POSITIVE_INFINITY): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : fallback;
}

/** 장기 SMA 위에 있을 때만 진입을 허용하는 추세 필터. trend=0이면 항상 통과 */
function aboveTrend(closes: number[], trend: number): boolean {
  if (trend === 0) return true;
  const value = sma(closes, trend);
  return value !== null && closes[closes.length - 1] > value;
}

/**
 * 단기 SMA가 장기 SMA를 상향 돌파하면 매수, 하향 돌파하면 매도.
 * trend > 0이면 종가가 trend일 SMA 위에 있을 때만 매수한다(횡보장 헛신호 억제).
 */
export function smaCrossoverStrategy(params: Record<string, number> = {}): Strategy {
  const fast = positiveInt(params.fast, 10);
  const slow = positiveInt(params.slow, 30);
  const trend = nonNegativeInt(params.trend, 200);
  if (fast >= slow) throw new Error('INVALID_STRATEGY_PARAMS:fast<slow');
  return {
    id: 'sma-crossover',
    params: { fast, slow, trend },
    warmupBars: Math.max(slow, trend) + 1,
    evaluate({ candles, position }) {
      const closes = candles.map((candle) => candle.close);
      const fastNow = sma(closes, fast);
      const slowNow = sma(closes, slow);
      const fastPrev = sma(closes.slice(0, -1), fast);
      const slowPrev = sma(closes.slice(0, -1), slow);
      if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) return WARMUP;
      if (trend > 0 && sma(closes, trend) === null) return WARMUP;
      const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
      const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;
      if (crossedUp && !position) {
        if (!aboveTrend(closes, trend)) return { action: 'hold', reason: `BELOW_TREND:${trend}` };
        return { action: 'buy', reason: `SMA${fast}>SMA${slow}${trend ? `+T${trend}` : ''}` };
      }
      if (crossedDown && position) return { action: 'sell', reason: `SMA${fast}<SMA${slow}` };
      return HOLD;
    },
  };
}

/**
 * 절대(시계열) 모멘텀: 종가가 lookback일 전 종가보다 높고 trend일 SMA 위이면 보유, 아니면 청산.
 * 단기 교차보다 신호가 드물고 추세를 길게 탄다.
 */
export function momentumStrategy(params: Record<string, number> = {}): Strategy {
  const lookback = positiveInt(params.lookback, 120);
  const trend = nonNegativeInt(params.trend, 200);
  return {
    id: 'momentum',
    params: { lookback, trend },
    warmupBars: Math.max(lookback + 1, trend),
    evaluate({ candles, position }) {
      const closes = candles.map((candle) => candle.close);
      if (closes.length < lookback + 1 || (trend > 0 && closes.length < trend)) return WARMUP;
      const last = closes[closes.length - 1];
      const base = closes[closes.length - 1 - lookback];
      const momentum = base > 0 ? ((last - base) / base) * 100 : 0;
      const trendOk = aboveTrend(closes, trend);
      if (!position) {
        if (momentum > 0 && trendOk) return { action: 'buy', reason: `MOMENTUM_UP:${momentum.toFixed(1)}%` };
        return { action: 'hold', reason: momentum <= 0 ? `MOMENTUM_DOWN:${momentum.toFixed(1)}%` : `BELOW_TREND:${trend}` };
      }
      if (momentum <= 0) return { action: 'sell', reason: `MOMENTUM_DOWN:${momentum.toFixed(1)}%` };
      if (!trendOk) return { action: 'sell', reason: `BELOW_TREND:${trend}` };
      return HOLD;
    },
  };
}

/**
 * 변동성 돌파(래리 윌리엄스): 당일 가격이 시가 + k × 전일 변동폭을 넘으면 매수, 다음 거래일 시가에 매도.
 * 백테스트는 돌파 가격에서 당일 체결, 익일 시가 청산을 가정한다. 자동 실행에서는 현재가가 돌파선을 넘은 5분 사이클에 시장가 매수한다.
 */
export function volatilityBreakoutStrategy(params: Record<string, number> = {}): Strategy {
  const k = positiveNumber(params.k, 0.5, 2);
  const trend = nonNegativeInt(params.trend, 0);
  return {
    id: 'volatility-breakout',
    params: { k, trend },
    warmupBars: Math.max(2, trend),
    evaluate({ candles, position, intraday }) {
      if (candles.length < 2) return WARMUP;
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      if (position) {
        if (position.entryDate && position.entryDate < last.date) return { action: 'sell', reason: 'VB_EXIT_NEXT_OPEN', price: last.open };
        return HOLD;
      }
      const closes = candles.map((candle) => candle.close);
      if (trend > 0 && sma(closes, trend) === null) return WARMUP;
      const level = last.open + k * (prev.high - prev.low);
      // 장중: 지금 가격이 돌파선 위인지. 일봉: 그날 고가가 돌파선에 닿았는지(그 순간 진입했다고 가정)
      const broke = intraday ? last.close >= level : last.high >= level;
      if (broke) {
        if (!aboveTrend(closes, trend)) return { action: 'hold', reason: `BELOW_TREND:${trend}` };
        return { action: 'buy', reason: `VB_BREAKOUT:k=${k}`, price: level };
      }
      return HOLD;
    },
  };
}

const STRATEGIES: Record<string, { factory: (params?: Record<string, number>) => Strategy; info: StrategyInfo }> = {
  'sma-crossover': {
    factory: smaCrossoverStrategy,
    info: { id: 'sma-crossover', label: 'SMA 교차 + 추세 필터', description: '단기 SMA가 장기 SMA를 상향 돌파하면 매수, 하향 돌파하면 매도. trend>0이면 종가가 trend일 SMA 위일 때만 매수해 횡보장 헛신호를 줄인다.', defaultParams: { fast: 10, slow: 30, trend: 200 } },
  },
  momentum: {
    factory: momentumStrategy,
    info: { id: 'momentum', label: '절대 모멘텀', description: 'lookback일 수익률이 양수이고 trend일 SMA 위이면 보유, 아니면 청산. 신호가 드물고 추세를 길게 탐.', defaultParams: { lookback: 120, trend: 200 } },
  },
  'volatility-breakout': {
    factory: volatilityBreakoutStrategy,
    info: { id: 'volatility-breakout', label: '변동성 돌파', description: '시가 + k×전일 변동폭 돌파 시 매수, 다음 거래일 시가 매도. 하루 단위 단기 전략.', defaultParams: { k: 0.5, trend: 0 } },
  },
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);
export const STRATEGY_INFOS: StrategyInfo[] = Object.values(STRATEGIES).map((entry) => entry.info);

export function createStrategy(spec: StrategySpec): Strategy {
  const entry = STRATEGIES[spec.id];
  if (!entry) throw new Error(`UNKNOWN_STRATEGY:${spec.id}`);
  return entry.factory(spec.params);
}

/**
 * 보유 포지션에 대한 손절/익절/트레일링 스탑 판단. 전략 신호보다 우선한다.
 * 트레일링 스탑은 진입일 이후 최고 종가(현재가 포함) 대비 하락률로 판단하며 entryDate와 candles가 있어야 동작한다.
 */
export function checkExitRules(position: StrategyPosition | null, price: number, rules: ExitRules, candles: Candle[] = []): Signal | null {
  if (!position || position.quantity <= 0 || position.averagePrice <= 0 || price <= 0) return null;
  const changePct = ((price - position.averagePrice) / position.averagePrice) * 100;
  if (rules.stopLossPct > 0 && changePct <= -rules.stopLossPct) return { action: 'sell', reason: `STOP_LOSS:${changePct.toFixed(2)}%` };
  if (rules.takeProfitPct > 0 && changePct >= rules.takeProfitPct) return { action: 'sell', reason: `TAKE_PROFIT:${changePct.toFixed(2)}%` };
  if (rules.trailingStopPct > 0 && position.entryDate) {
    const peak = candles.reduce((max, candle) => (candle.date >= position.entryDate! && candle.close > max ? candle.close : max), price);
    const drawdownPct = ((price - peak) / peak) * 100;
    if (drawdownPct <= -rules.trailingStopPct) return { action: 'sell', reason: `TRAILING_STOP:${drawdownPct.toFixed(2)}%` };
  }
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
  if (![rules.stopLossPct, rules.takeProfitPct, rules.trailingStopPct].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new Error('INVALID_EXIT_RULES');
  return rules;
}

export function validateSizingRules(value: unknown): SizingRules {
  const rules = { ...DEFAULT_SIZING_RULES, ...(value && typeof value === 'object' ? value : {}) } as SizingRules;
  const values = [rules.cashFraction, rules.maxOrderAmount, rules.maxOrderQuantity, rules.maxPositionQuantity];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) || rules.cashFraction > 1) throw new Error('INVALID_SIZING_RULES');
  return rules;
}
