import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, checkRisk, type RiskState } from './risk-manager';
import type { CreateOrderRequest, Order } from './order-domain';

const now = '2026-09-14T12:00:00.000Z';
const request = (overrides: Partial<CreateOrderRequest> = {}): CreateOrderRequest => ({ id: 'r1', clientOrderId: 'c1', symbol: '005930', side: 'buy', orderType: 'limit', quantity: 1, limitPrice: 70000, ...overrides });
const state = (overrides: Partial<RiskState> = {}): RiskState => ({ positions: [], orders: [], dailyLoss: 0, ...overrides });
const market = { referencePrice: 70000, quoteAsOf: '2026-09-14T11:59:50.000Z', now };
const order = (i: number): Order => ({ ...request({ id: `r${i}`, clientOrderId: `c${i}` }), executedQuantity: 1, averageExecutedPrice: 70000, status: 'FILLED', createdAt: now, updatedAt: now });

describe('risk manager', () => {
  it('allows a safe order', () => expect(checkRisk({ request: request(), state: state(), market, config: DEFAULT_RISK_CONFIG, killSwitchActive: false, reconciliationAllowed: true, apiHealthy: true }).reason).toBe('OK'));
  it('blocks kill switch', () => expect(checkRisk({ request: request(), state: state(), market, config: DEFAULT_RISK_CONFIG, killSwitchActive: true, reconciliationAllowed: true, apiHealthy: true }).reason).toBe('KILL_SWITCH_ACTIVE'));
  it('blocks reconciliation mismatch and API failure', () => {
    expect(checkRisk({ request: request(), state: state(), market, config: DEFAULT_RISK_CONFIG, killSwitchActive: false, reconciliationAllowed: false, apiHealthy: true }).reason).toBe('RECONCILIATION_MISMATCH');
    expect(checkRisk({ request: request(), state: state(), market, config: DEFAULT_RISK_CONFIG, killSwitchActive: false, reconciliationAllowed: true, apiHealthy: false }).reason).toBe('API_UNHEALTHY');
  });
  it('blocks stale quotes', () => expect(checkRisk({ request: request(), state: state(), market: { ...market, quoteAsOf: '2026-09-14T11:59:00.000Z' }, config: DEFAULT_RISK_CONFIG, killSwitchActive: false, reconciliationAllowed: true, apiHealthy: true }).reason).toBe('STALE_QUOTE'));
  it('blocks quantity, amount and position limits', () => {
    expect(checkRisk({ request: request({ quantity: 1001 }), state: state(), market, config: DEFAULT_RISK_CONFIG, killSwitchActive: false, reconciliationAllowed: true, apiHealthy: true }).reason).toBe('MAX_ORDER_QUANTITY');
    expect(checkRisk({ request: request({ quantity: 20 }), state: state(), market, config: DEFAULT_RISK_CONFIG, killSwitchActive: false, reconciliationAllowed: true, apiHealthy: true }).reason).toBe('MAX_ORDER_AMOUNT');
    expect(checkRisk({ request: request({ quantity: 1 }), state: state({ positions: [{ symbol: '005930', quantity: 5000 }] }), market, config: DEFAULT_RISK_CONFIG, killSwitchActive: false, reconciliationAllowed: true, apiHealthy: true }).reason).toBe('MAX_POSITION_QUANTITY');
  });
  it('blocks daily order and loss limits', () => {
    expect(checkRisk({ request: request(), state: state({ orders: Array.from({ length: 20 }, (_, i) => order(i)) }), market, config: DEFAULT_RISK_CONFIG, killSwitchActive: false, reconciliationAllowed: true, apiHealthy: true }).reason).toBe('MAX_DAILY_ORDERS');
    expect(checkRisk({ request: request(), state: state({ dailyLoss: 100000 }), market, config: DEFAULT_RISK_CONFIG, killSwitchActive: false, reconciliationAllowed: true, apiHealthy: true }).reason).toBe('MAX_DAILY_LOSS');
  });
});
