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

    const quotes = await Promise.all(
      uniqueSymbols.map(async (symbol) => {
        const url = new URL('/quote', this.baseUrl);
        url.searchParams.set('symbol', symbol);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Quote API request failed: ${response.status}`);
        return (await response.json()) as QuoteApiResponse;
      }),
    );

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
