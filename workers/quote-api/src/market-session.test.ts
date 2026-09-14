import { describe, expect, it } from 'vitest';
import { assertMarketOpen, getMarketSession } from './market-session';

const kst = (value: string) => new Date(`${value}+09:00`);

describe('market session', () => {
  it('opens during the regular KRX session on weekdays', () => {
    expect(getMarketSession(kst('2026-09-14T09:00:00'))).toMatchObject({ isOpen: true, status: 'OPEN' });
    expect(getMarketSession(kst('2026-09-14T15:29:59'))).toMatchObject({ isOpen: true, status: 'OPEN' });
    expect(() => assertMarketOpen(kst('2026-09-14T10:30:00'))).not.toThrow();
  });

  it('blocks before the open and at/after the close', () => {
    expect(getMarketSession(kst('2026-09-14T08:59:59'))).toMatchObject({ isOpen: false, status: 'PRE_OPEN' });
    expect(getMarketSession(kst('2026-09-14T15:30:00'))).toMatchObject({ isOpen: false, status: 'POST_CLOSE' });
    expect(() => assertMarketOpen(kst('2026-09-14T15:30:00'))).toThrow('MARKET_SESSION_POST_CLOSE');
  });

  it('blocks weekends regardless of clock time', () => {
    expect(getMarketSession(kst('2026-09-12T10:00:00'))).toMatchObject({ isOpen: false, status: 'WEEKEND' });
    expect(getMarketSession(kst('2026-09-13T14:00:00'))).toMatchObject({ isOpen: false, status: 'WEEKEND' });
  });

  it('uses KST for UTC boundary checks', () => {
    expect(getMarketSession(new Date('2026-09-14T00:00:00.000Z'))).toMatchObject({ isOpen: true, status: 'OPEN' });
  });
});
