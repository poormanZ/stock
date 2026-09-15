import { describe, expect, it } from 'vitest';
import { calculateDailyLoss } from './daily-loss';

describe('daily loss', () => {
  it('calculates net realized loss after fee, tax and loan interest', () => {
    const result = calculateDailyLoss([
      { tradDt: '20260915', realizedProfitLoss: -80000, fee: 1000, tax: 2000, loanInterest: 500 },
      { tradDt: '20260915', realizedProfitLoss: 30000, fee: 500, tax: 0, loanInterest: 0 },
      { tradDt: '20260914', realizedProfitLoss: -999999, fee: 1, tax: 1, loanInterest: 1 },
    ], '20260915');

    expect(result.realizedProfitLoss).toBe(-50000);
    expect(result.fee).toBe(1500);
    expect(result.tax).toBe(2000);
    expect(result.loanInterest).toBe(500);
    expect(result.netProfitLoss).toBe(-54000);
    expect(result.dailyLoss).toBe(54000);
  });

  it('returns zero daily loss when net realized P/L is positive', () => {
    const result = calculateDailyLoss([
      { tradDt: '20260915', realizedProfitLoss: 10000, fee: 500, tax: 500, loanInterest: 0 },
    ], '20260915');

    expect(result.netProfitLoss).toBe(9000);
    expect(result.dailyLoss).toBe(0);
  });

  it('returns zero for a day without realized trades', () => {
    expect(calculateDailyLoss([], '20260915')).toEqual({
      date: '20260915',
      realizedProfitLoss: 0,
      fee: 0,
      tax: 0,
      loanInterest: 0,
      netProfitLoss: 0,
      dailyLoss: 0,
    });
  });
});
