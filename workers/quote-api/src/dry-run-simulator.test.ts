import { describe, expect, it } from 'vitest';
import { createDryRunState, simulateOrder } from './dry-run-simulator';

const buy = { id: 'o1', clientOrderId: 'c1', symbol: '005930', side: 'buy' as const, orderType: 'market' as const, quantity: 10 };

describe('dry-run simulator', () => {
  it('fills market buys with slippage and fee and updates cash/position', () => {
    const state = createDryRunState(1_000_000);
    const result = simulateOrder(state, buy, 70_000);
    expect(result.executedQuantity).toBe(10);
    expect(result.executedPrice).toBe(70_035);
    expect(result.grossAmount).toBe(700_350);
    expect(result.fee).toBe(1_051);
    expect(result.tax).toBe(0);
    expect(result.cash).toBe(298_599);
    expect(result.positions[0]).toMatchObject({ symbol: '005930', quantity: 10 });
    expect(result.order.status).toBe('FILLED');
  });

  it('does not fill a limit order when the reference price misses the limit', () => {
    const state = createDryRunState();
    const result = simulateOrder(state, { ...buy, id: 'o2', clientOrderId: 'c2', orderType: 'limit', limitPrice: 69_000 }, 70_000);
    expect(result.filled).toBe(false);
    expect(result.executedQuantity).toBe(0);
    expect(result.order.status).toBe('ACCEPTED');
    expect(state.cash).toBe(10_000_000);
  });

  it('supports partial fills and then selling the remaining position', () => {
    const state = createDryRunState(1_000_000);
    const first = simulateOrder(state, buy, 50_000, 4, { feeBps: 0, sellTaxBps: 20, slippageBps: 0 });
    expect(first.order.status).toBe('PARTIALLY_FILLED');
    expect(state.positions[0].quantity).toBe(4);
    const sell = simulateOrder(state, { id: 'o2', clientOrderId: 'c2', symbol: '005930', side: 'sell', orderType: 'market', quantity: 4 }, 55_000, 4, { feeBps: 0, sellTaxBps: 20, slippageBps: 0 });
    expect(sell.order.status).toBe('FILLED');
    expect(state.positions).toEqual([]);
    expect(state.cash).toBe(1_019_560);
  });

  it('rejects buys without enough virtual cash and sells without enough position', () => {
    expect(() => simulateOrder(createDryRunState(1), buy, 70_000)).toThrow('INSUFFICIENT_DRY_RUN_CASH');
    expect(() => simulateOrder(createDryRunState(), { id: 'o2', clientOrderId: 'c2', symbol: '005930', side: 'sell', orderType: 'market', quantity: 1 }, 70_000)).toThrow('INSUFFICIENT_DRY_RUN_POSITION');
  });
});
