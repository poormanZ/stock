export interface DailyLossRow {
  tradDt: string;
  realizedProfitLoss: number;
  fee: number;
  tax: number;
  loanInterest: number;
}

export interface DailyLossResult {
  date: string;
  realizedProfitLoss: number;
  fee: number;
  tax: number;
  loanInterest: number;
  netProfitLoss: number;
  dailyLoss: number;
}

/**
 * KIS 기간별매매손익 명세를 KST 거래일 단위로 집계한다.
 * dailyLoss는 순실현손익이 음수인 경우에만 양수의 손실 금액으로 변환한다.
 */
export function calculateDailyLoss(rows: DailyLossRow[], date: string): DailyLossResult {
  const selected = rows.filter((row) => row.tradDt === date);
  const realizedProfitLoss = selected.reduce((sum, row) => sum + row.realizedProfitLoss, 0);
  const fee = selected.reduce((sum, row) => sum + row.fee, 0);
  const tax = selected.reduce((sum, row) => sum + row.tax, 0);
  const loanInterest = selected.reduce((sum, row) => sum + row.loanInterest, 0);
  const netProfitLoss = realizedProfitLoss - fee - tax - loanInterest;

  return {
    date,
    realizedProfitLoss,
    fee,
    tax,
    loanInterest,
    netProfitLoss,
    dailyLoss: Math.max(0, -netProfitLoss),
  };
}
