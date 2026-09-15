import type { StockQuote } from '../types/stock';

export type QuoteFreshness = 'FRESH' | 'STALE' | 'TIME_UNKNOWN' | 'CLOSED' | 'INVALID_TIME';

const STALE_AFTER_MS = 15 * 60 * 1000;

function parseAsOf(value: string): Date | null {
  const match = /^(\d{8})\s+(\d{6})$/.exec(value.trim());
  if (!match) return null;
  const [, date, time] = match;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 시세 신선도. KIS 체결시각(asOf)이 있으면 그것을, 없으면 Worker 수신 시각(fetchedAt)을 기준으로 판단한다.
 * 둘 다 없으면 시각 미확인이다.
 */
function parseIso(value?: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getQuoteFreshness(quote: Pick<StockQuote, 'asOf' | 'marketStatus'> & { fetchedAt?: string }, now = new Date()): QuoteFreshness {
  if (quote.marketStatus === 'CLOSED') return 'CLOSED';
  const hasAsOf = Boolean(quote.asOf.trim());
  if (!hasAsOf && !quote.fetchedAt) return 'TIME_UNKNOWN';

  const asOf = hasAsOf ? parseAsOf(quote.asOf) : parseIso(quote.fetchedAt);
  if (!asOf) return 'INVALID_TIME';

  const age = now.getTime() - asOf.getTime();
  if (age < 0) return 'INVALID_TIME';
  return age > STALE_AFTER_MS ? 'STALE' : 'FRESH';
}

export function formatAsOf(asOf: string): string {
  const value = asOf.trim();
  if (!value) return '시간 미확인';
  const match = /^(\d{8})\s+(\d{6})$/.exec(value);
  if (!match) return value;
  const [, date, time] = match;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}
