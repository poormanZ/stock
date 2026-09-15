export const QUOTE_MAX_SYMBOLS = 20;

export function isValidDomesticSymbol(symbol: string): boolean {
  return /^\d{6}$/.test(symbol);
}

export function parseSymbols(value: string | null): string[] {
  return [...new Set((value ?? '').split(',').map((symbol) => symbol.trim()).filter(Boolean))];
}

export function validateSymbols(symbols: string[]): boolean {
  return symbols.length > 0
    && symbols.length <= QUOTE_MAX_SYMBOLS
    && symbols.every(isValidDomesticSymbol);
}
