import type { StockQuote } from '../types/stock';

const STORAGE_KEY = 'stock-dashboard.watchlist';

export function loadWatchlist(defaultStocks: StockQuote[]): StockQuote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...defaultStocks];

    const symbols = JSON.parse(raw);
    if (!Array.isArray(symbols)) return [...defaultStocks];

    const validSymbols = symbols.filter((symbol): symbol is string => typeof symbol === 'string');
    const restored = validSymbols
      .map((symbol) => defaultStocks.find((stock) => stock.symbol === symbol))
      .filter((stock): stock is StockQuote => stock !== undefined);

    return restored.length > 0 ? restored : [...defaultStocks];
  } catch {
    return [...defaultStocks];
  }
}

export function saveWatchlist(stocks: StockQuote[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stocks.map((stock) => stock.symbol)));
  } catch {
    // localStorage may be unavailable in private/restricted browsing contexts.
  }
}
