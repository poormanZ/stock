import { describe, expect, it } from 'vitest';
import { checkLiveTradingGate, LIVE_TRADING_CONFIRMATION, type LiveGateInput } from './live-trading-gate';

const now = new Date('2026-09-15T01:00:00.000Z');
const open: LiveGateInput = {
  liveTradingEnabled: 'true',
  paperVerificationDate: '20260901',
  environment: 'LIVE',
  accountConfigured: true,
  killSwitchActive: false,
  marketOpen: true,
  arm: { armedAt: now.toISOString(), armedUntil: new Date(now.getTime() + 60_000).toISOString(), reason: 'test' },
  confirmation: LIVE_TRADING_CONFIRMATION,
  now,
};

describe('live trading gate', () => {
  it('is disabled by default and requires the exact flag value', () => {
    expect(checkLiveTradingGate({ ...open, liveTradingEnabled: undefined }).reason).toBe('LIVE_TRADING_DISABLED');
    expect(checkLiveTradingGate({ ...open, liveTradingEnabled: 'TRUE' }).reason).toBe('LIVE_TRADING_DISABLED');
    expect(checkLiveTradingGate({ ...open, liveTradingEnabled: '1' }).reason).toBe('LIVE_TRADING_DISABLED');
  });

  it('requires a past paper verification date, LIVE environment and account', () => {
    expect(checkLiveTradingGate({ ...open, paperVerificationDate: undefined }).reason).toBe('PAPER_VERIFICATION_REQUIRED');
    expect(checkLiveTradingGate({ ...open, paperVerificationDate: '20991231' }).reason).toBe('PAPER_VERIFICATION_REQUIRED');
    expect(checkLiveTradingGate({ ...open, environment: 'PAPER' }).reason).toBe('LIVE_ENVIRONMENT_REQUIRED');
    expect(checkLiveTradingGate({ ...open, accountConfigured: false }).reason).toBe('ACCOUNT_NOT_CONFIGURED');
  });

  it('blocks on kill switch, closed market, missing/expired arm and wrong confirmation', () => {
    expect(checkLiveTradingGate({ ...open, killSwitchActive: true }).reason).toBe('KILL_SWITCH_ACTIVE');
    expect(checkLiveTradingGate({ ...open, marketOpen: false }).reason).toBe('MARKET_SESSION_CLOSED');
    expect(checkLiveTradingGate({ ...open, arm: null }).reason).toBe('LIVE_TRADING_NOT_ARMED');
    expect(checkLiveTradingGate({ ...open, arm: { ...open.arm!, armedUntil: now.toISOString() } }).reason).toBe('LIVE_TRADING_NOT_ARMED');
    expect(checkLiveTradingGate({ ...open, confirmation: 'yes' }).reason).toBe('LIVE_CONFIRMATION_REQUIRED');
  });

  it('allows only when every check passes', () => {
    const result = checkLiveTradingGate(open);
    expect(result.allowed).toBe(true);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });
});
