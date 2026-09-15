import { describe, expect, it } from 'vitest';
import { assertAccepted, KISRejectedError, kisTimestampToIso, toKstDate } from './kis-common';

describe('kis-common', () => {
  it('converts KIS KST timestamps to ISO and rejects other shapes', () => {
    expect(kisTimestampToIso('20260914 153012')).toBe('2026-09-14T06:30:12.000Z');
    expect(kisTimestampToIso('')).toBeUndefined();
    expect(kisTimestampToIso(undefined)).toBeUndefined();
    expect(kisTimestampToIso('2026-09-14T06:30:12Z')).toBeUndefined();
  });

  it('derives KST calendar dates and tolerates invalid input', () => {
    expect(toKstDate(new Date('2026-09-14T15:30:00.000Z'))).toBe('20260915');
    expect(toKstDate('2026-09-14T14:59:59.000Z')).toBe('20260914');
    expect(toKstDate('not-a-date')).toBeNull();
  });

  it('treats a missing rt_cd as a rejected KIS response', () => {
    expect(() => assertAccepted('balance', { rt_cd: '0' })).not.toThrow();
    expect(() => assertAccepted('balance', {})).toThrow(KISRejectedError);
    expect(() => assertAccepted('buyable', { rt_cd: '1', msg_cd: 'APBK0919', msg1: ' no cash ' }))
      .toThrow('KIS buyable request failed: APBK0919 - no cash');
  });
});
