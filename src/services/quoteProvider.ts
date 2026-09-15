import type { StockQuote } from '../types/stock';

export interface QuoteProvider {
  getQuotes(symbols: string[]): Promise<StockQuote[]>;
}
