export type MarketStatus = 'OPEN' | 'CLOSED';
export type QuoteDirection = 'up' | 'down' | 'flat';

export interface StockQuote {
  symbol: string;
  name: string;
  market: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  marketStatus: MarketStatus;
  asOf: string;
  /** Worker가 시세를 수신한 시각(ISO 8601). 샘플 데이터에는 없다 */
  fetchedAt?: string;
  source: string;
  delayed: boolean;
}

export function getQuoteDirection(change: number): QuoteDirection {
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'flat';
}
