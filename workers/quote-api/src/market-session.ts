const KST_TIME_ZONE = 'Asia/Seoul';
const MARKET_OPEN_MINUTES = 9 * 60;
const MARKET_CLOSE_MINUTES = 15 * 60 + 30;

export type MarketSessionStatus = 'OPEN' | 'PRE_OPEN' | 'POST_CLOSE' | 'WEEKEND';

export interface MarketSession {
  isOpen: boolean;
  status: MarketSessionStatus;
  asOf: string;
  timeZone: string;
}

function getKstParts(now: Date): { weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: KST_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday);
  return { weekday, hour: Number(values.hour), minute: Number(values.minute) };
}

/**
 * Current domestic equity regular session supported by the order adapter.
 * Holidays are intentionally not inferred here; a future KRX/KIS holiday source
 * should be added before treating a weekday as a guaranteed trading day.
 */
export function getMarketSession(now = new Date()): MarketSession {
  const { weekday, hour, minute } = getKstParts(now);
  const minutes = hour * 60 + minute;

  if (weekday === 0 || weekday === 6) {
    return { isOpen: false, status: 'WEEKEND', asOf: now.toISOString(), timeZone: KST_TIME_ZONE };
  }
  if (minutes < MARKET_OPEN_MINUTES) {
    return { isOpen: false, status: 'PRE_OPEN', asOf: now.toISOString(), timeZone: KST_TIME_ZONE };
  }
  if (minutes >= MARKET_CLOSE_MINUTES) {
    return { isOpen: false, status: 'POST_CLOSE', asOf: now.toISOString(), timeZone: KST_TIME_ZONE };
  }
  return { isOpen: true, status: 'OPEN', asOf: now.toISOString(), timeZone: KST_TIME_ZONE };
}

export function assertMarketOpen(now = new Date()): MarketSession {
  const session = getMarketSession(now);
  if (!session.isOpen) {
    throw new Error(`MARKET_SESSION_${session.status}`);
  }
  return session;
}
