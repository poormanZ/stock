import { describe, expect, it } from 'vitest';
import { formatAsOf, getQuoteFreshness } from './quoteFreshness';

describe('quote freshness', () => {
  const now = new Date('2026-09-14T06:30:00.000Z');

  it('marks recent KST execution time as fresh', () => {
    expect(getQuoteFreshness({ asOf: '20260914 152500', marketStatus: 'OPEN' }, now)).toBe('FRESH');
  });

  it('marks quotes older than fifteen minutes as stale', () => {
    expect(getQuoteFreshness({ asOf: '20260914 151400', marketStatus: 'OPEN' }, now)).toBe('STALE');
  });

  it('does not treat missing or invalid time as fresh', () => {
    expect(getQuoteFreshness({ asOf: '', marketStatus: 'OPEN' }, now)).toBe('TIME_UNKNOWN');
    expect(getQuoteFreshness({ asOf: 'unknown', marketStatus: 'OPEN' }, now)).toBe('INVALID_TIME');
  });

  it('marks closed market separately', () => {
    expect(getQuoteFreshness({ asOf: '20260914 151500', marketStatus: 'CLOSED' }, now)).toBe('CLOSED');
  });

  it('formats KIS timestamp for display', () => {
    expect(formatAsOf('20260914 152500')).toBe('2026-09-14 15:25:00');
    expect(formatAsOf('')).toBe('시간 미확인');
  });
});
