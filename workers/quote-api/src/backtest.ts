import { createDryRunState, DEFAULT_DRY_RUN_CONFIG, simulateOrder, type DryRunConfig } from './dry-run-simulator';
import type { Candle, ExitRules, SizingRules, Strategy } from './strategy';
import { checkExitRules, sizeEntry } from './strategy';

export interface BacktestTrade {
  entryDate: string;
  exitDate: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  /** 수수료·세금 반영 후 실현 손익 */
  pnl: number;
  reason: string;
}

export interface BacktestMetrics {
  bars: number;
  initialCash: number;
  finalEquity: number;
  totalReturnPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  /** 총이익 / 총손실. 손실이 없으면 null */
  profitFactor: number | null;
  maxDrawdownPct: number;
  totalFees: number;
  totalTaxes: number;
  /** 같은 구간(워밍업 이후 첫 봉 시가 → 마지막 종가) 단순 보유 수익률. 전략 비교 기준선 */
  buyAndHoldReturnPct: number;
}

export interface BacktestResult {
  strategy: { id: string; params: Record<string, number> };
  symbol: string;
  startDate: string;
  endDate: string;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: { date: string; equity: number }[];
  openPosition: { quantity: number; averagePrice: number } | null;
}

export interface BacktestInput {
  symbol: string;
  candles: Candle[];
  strategy: Strategy;
  initialCash: number;
  config?: DryRunConfig;
  exit: ExitRules;
  sizing: SizingRules;
}

/**
 * 봉 i 종가에서 신호를 내고 봉 i+1 시가에 체결한다(미래 참조 방지).
 * 신호에 price가 있으면(돌파 가격, 당일 시가 등) 봉 i 안에서 그 가격으로 즉시 체결한다.
 * 체결·수수료·세금·슬리피지는 DRY_RUN 시뮬레이터를 그대로 사용해 실행 경로와 같은 비용 모델을 쓴다.
 */
export function runBacktest(input: BacktestInput): BacktestResult {
  const { symbol, candles, strategy, initialCash, exit, sizing } = input;
  const config = input.config ?? DEFAULT_DRY_RUN_CONFIG;
  if (!Number.isFinite(initialCash) || initialCash <= 0) throw new Error('INVALID_INITIAL_CASH');
  if (candles.length < strategy.warmupBars + 1) throw new Error('INSUFFICIENT_CANDLES');

  const state = createDryRunState(initialCash);
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  let totalFees = 0;
  let totalTaxes = 0;
  let peak = initialCash;
  let maxDrawdownPct = 0;
  let entry: { date: string; quantity: number; price: number; cost: number } | null = null;
  let sequence = 0;

  const positionOf = () => {
    const held = state.positions.find((position) => position.symbol === symbol);
    return held ? { quantity: held.quantity, averagePrice: held.averagePrice, entryDate: entry?.date } : null;
  };
  /** 신호 봉 내 체결 가격은 그 봉의 고가·저가 안으로 제한한다 */
  const clamp = (price: number, bar: Candle) => Math.min(Math.max(price, bar.low), bar.high);
  // 매수 비용 = 체결가(슬리피지 반영) × (1 + 수수료)
  const entryCostBps = ((1 + config.slippageBps / 10_000) * (1 + config.feeBps / 10_000) - 1) * 10_000;
  // 시뮬레이터와 같은 반올림으로 총비용을 계산해 현금을 넘지 않는 수량으로 줄인다
  const affordable = (quantity: number, price: number): number => {
    const executed = price * (1 + config.slippageBps / 10_000);
    for (let q = quantity; q > 0; q -= 1) {
      const gross = Math.round(executed * q);
      if (gross + Math.round((gross * config.feeBps) / 10_000) <= state.cash) return q;
    }
    return 0;
  };

  for (let i = strategy.warmupBars - 1; i < candles.length - 1; i += 1) {
    const window = candles.slice(0, i + 1);
    const bar = candles[i];
    const next = candles[i + 1];
    const position = positionOf();

    const signal = checkExitRules(position, bar.close, exit, window) ?? strategy.evaluate({ symbol, candles: window, position });
    const immediate = signal.price !== undefined && signal.price > 0;
    const fillBar = immediate ? bar : next;
    const fillPrice = immediate ? clamp(signal.price!, bar) : next.open;

    if (signal.action === 'buy' && !position) {
      const quantity = affordable(sizeEntry(state.cash, fillPrice, 0, sizing, entryCostBps), fillPrice);
      if (quantity > 0) {
        sequence += 1;
        const result = simulateOrder(state, { id: `bt-${sequence}`, clientOrderId: `BT-${sequence}`, symbol, side: 'buy', orderType: 'market', quantity }, fillPrice, quantity, config);
        totalFees += result.fee;
        entry = { date: fillBar.date, quantity, price: result.executedPrice, cost: result.grossAmount + result.fee };
      }
    } else if (signal.action === 'sell' && position && entry) {
      sequence += 1;
      const result = simulateOrder(state, { id: `bt-${sequence}`, clientOrderId: `BT-${sequence}`, symbol, side: 'sell', orderType: 'market', quantity: position.quantity }, fillPrice, position.quantity, config);
      totalFees += result.fee;
      totalTaxes += result.tax;
      trades.push({
        entryDate: entry.date,
        exitDate: fillBar.date,
        quantity: position.quantity,
        entryPrice: entry.price,
        exitPrice: result.executedPrice,
        pnl: result.grossAmount - result.fee - result.tax - entry.cost,
        reason: signal.reason,
      });
      entry = null;
    }

    const equity = state.cash + (positionOf()?.quantity ?? 0) * next.close;
    equityCurve.push({ date: next.date, equity });
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  }

  const last = candles[candles.length - 1];
  const open = positionOf();
  const finalEquity = state.cash + (open?.quantity ?? 0) * last.close;
  const firstOpen = candles[strategy.warmupBars - 1]?.open ?? candles[0].open;
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));

  return {
    strategy: { id: strategy.id, params: strategy.params },
    symbol,
    startDate: candles[0].date,
    endDate: last.date,
    metrics: {
      bars: candles.length,
      initialCash,
      finalEquity,
      totalReturnPct: ((finalEquity - initialCash) / initialCash) * 100,
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      maxDrawdownPct,
      totalFees,
      totalTaxes,
      buyAndHoldReturnPct: firstOpen > 0 ? ((last.close - firstOpen) / firstOpen) * 100 : 0,
    },
    trades,
    equityCurve,
    openPosition: open ? { quantity: open.quantity, averagePrice: open.averagePrice } : null,
  };
}
