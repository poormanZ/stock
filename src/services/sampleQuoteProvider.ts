import type { StockQuote } from '../types/stock';
import type { QuoteProvider } from './quoteProvider';

export class SampleQuoteProvider implements QuoteProvider {
  constructor(private readonly catalog: StockQuote[]) {}

  async getQuotes(symbols: string[]): Promise<StockQuote[]> {
    const requested = new Set(symbols);
    return this.catalog.filter((quote) => requested.has(quote.symbol));
  }
}
