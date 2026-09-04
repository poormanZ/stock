import type { QuoteProvider } from './quoteProvider';
import type { StockQuote } from '../types/stock';

interface QuoteApiResponse extends Omit<StockQuote, 'name' | 'marketStatus'> {
  name?: string;
  marketStatus?: StockQuote['marketStatus'];
}

export class HttpQuoteProvider implements QuoteProvider {
  constructor(private readonly baseUrl: string) {}

  async getQuotes(symbols: string[]): Promise<StockQuote[]> {
    const uniqueSymbols = [...new Set(symbols)];
    if (uniqueSymbols.length === 0) return [];

    const url = new URL('/quotes', this.baseUrl);
    url.searchParams.set('symbols', uniqueSymbols.join(','));

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Quote API request failed: ${response.status}`);

    const quotes = (await response.json()) as QuoteApiResponse[];
    return quotes.map((quote) => ({
      symbol: quote.symbol,
      name: quote.name ?? quote.symbol,
      market: quote.market,
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      volume: quote.volume,
      marketStatus: quote.marketStatus ?? 'OPEN',
      asOf: quote.asOf,
      source: quote.source,
      delayed: quote.delayed,
    }));
  }
}
