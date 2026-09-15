/**
 * 대시보드에서 고를 수 있는 자동매매 프리셋. 파라미터와 청산 규칙은 Worker의 전략 정의와 맞춘다.
 * 백테스트 근거는 docs/trading.md §9.
 */
export interface StrategyPreset {
  id: string;
  label: string;
  summary: string;
  config: {
    strategy: { id: string; params: Record<string, number> };
    exit: { stopLossPct: number; takeProfitPct: number; trailingStopPct: number };
  };
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'trend-crossover',
    label: 'SMA 10/30 + 200일 추세 필터 (기본)',
    summary: '10일선이 30일선을 상향 돌파하고 종가가 200일선 위일 때 매수, 하향 돌파·손절 7%·최고가 대비 -10%에 매도. 백테스트 세 구간 모두 수익률이 최대낙폭을 넘은 유일한 후보.',
    config: { strategy: { id: 'sma-crossover', params: { fast: 10, slow: 30, trend: 200 } }, exit: { stopLossPct: 7, takeProfitPct: 0, trailingStopPct: 10 } },
  },
  {
    id: 'fast-crossover',
    label: 'SMA 5/20 + 트레일링 8%',
    summary: '신호가 잦은 단기 교차. 익절 대신 트레일링 스탑으로 추세를 끝까지 탄다. 거래 횟수와 최대낙폭이 기본 전략보다 크다.',
    config: { strategy: { id: 'sma-crossover', params: { fast: 5, slow: 20, trend: 0 } }, exit: { stopLossPct: 5, takeProfitPct: 0, trailingStopPct: 8 } },
  },
  {
    id: 'momentum',
    label: '절대 모멘텀 120일 + 200일선',
    summary: '6개월 수익률이 양수이고 200일선 위면 보유, 아니면 청산. 강세장에 강하지만 최대낙폭이 크고 승률이 낮다.',
    config: { strategy: { id: 'momentum', params: { lookback: 120, trend: 200 } }, exit: { stopLossPct: 7, takeProfitPct: 0, trailingStopPct: 12 } },
  },
  {
    id: 'legacy',
    label: 'SMA 5/20 + 손절 5% / 익절 10% (이전 기본)',
    summary: '이전 기본 설정. 고정 익절이 추세를 잘라 백테스트 수익이 거의 없었다. 비교용으로만 남긴다.',
    config: { strategy: { id: 'sma-crossover', params: { fast: 5, slow: 20, trend: 0 } }, exit: { stopLossPct: 5, takeProfitPct: 10, trailingStopPct: 0 } },
  },
];

export const DEFAULT_PRESET_ID = STRATEGY_PRESETS[0].id;

export function findPreset(id: string): StrategyPreset {
  return STRATEGY_PRESETS.find((preset) => preset.id === id) ?? STRATEGY_PRESETS[0];
}
