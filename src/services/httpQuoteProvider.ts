import type { QuoteProvider } from './quoteProvider';
import type { StockQuote } from '../types/stock';

export class QuoteApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = 'QuoteApiError';
  }
}

interface QuoteApiResponse extends Omit<StockQuote, 'name' | 'marketStatus'> {
  name?: string;
  marketStatus?: StockQuote['marketStatus'];
}

const SAFE_ERROR_CODES = new Set([
  'INVALID_SYMBOLS',
  'METHOD_NOT_ALLOWED',
  'NOT_FOUND',
  'KIS_RATE_LIMITED',
  'KIS_UPSTREAM_ERROR',
  'QUOTE_UNAVAILABLE',
  'KIS_TIMEOUT',
]);

export class HttpQuoteProvider implements QuoteProvider {
  constructor(private readonly baseUrl: string) {}

  async getQuotes(symbols: string[]): Promise<StockQuote[]> {
    const uniqueSymbols = [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))];
    if (uniqueSymbols.length === 0) return [];

    const url = new URL('/quotes', this.baseUrl);
    url.searchParams.set('symbols', uniqueSymbols.join(','));

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        let code = 'QUOTE_UNAVAILABLE';
        try {
          const body = (await response.json()) as { error?: unknown };
          if (typeof body.error === 'string' && SAFE_ERROR_CODES.has(body.error)) code = body.error;
        } catch {
          // Keep the generic safe error code when the response is not JSON.
        }
        throw new QuoteApiError(code, response.status);
      }

      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new QuoteApiError('QUOTE_UNAVAILABLE', 502);

      return body.map((item) => {
        const quote = item as QuoteApiResponse;
        if (!quote.symbol || typeof quote.price !== 'number' || typeof quote.change !== 'number') {
          throw new QuoteApiError('QUOTE_UNAVAILABLE', 502);
        }
        return {
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
        };
      });
    } catch (error) {
      if (error instanceof QuoteApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new QuoteApiError('KIS_TIMEOUT', 504);
      throw new QuoteApiError('QUOTE_UNAVAILABLE', 502);
    } finally {
      window.clearTimeout(timeout);
    }
  }
}
