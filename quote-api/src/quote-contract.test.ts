import { describe, expect, it } from 'vitest';
import { isValidDomesticSymbol, parseSymbols, QUOTE_MAX_SYMBOLS, validateSymbols } from './quote-contract';

describe('quote contract', () => {
  it('parses comma-separated symbols, trims and deduplicates', () => {
    expect(parseSymbols(' 005930,000660,005930 ,, 035420 ')).toEqual(['005930', '000660', '035420']);
  });

  it('accepts exactly six-digit domestic symbols', () => {
    expect(isValidDomesticSymbol('005930')).toBe(true);
    expect(isValidDomesticSymbol('5930')).toBe(false);
    expect(isValidDomesticSymbol('0059300')).toBe(false);
    expect(isValidDomesticSymbol('ABCDEF')).toBe(false);
  });

  it('rejects empty, over-limit, or malformed symbol lists', () => {
    expect(validateSymbols([])).toBe(false);
    expect(validateSymbols(['005930'])).toBe(true);
    expect(validateSymbols(Array.from({ length: QUOTE_MAX_SYMBOLS }, (_, i) => String(i).padStart(6, '0')))).toBe(true);
    expect(validateSymbols(Array.from({ length: QUOTE_MAX_SYMBOLS + 1 }, (_, i) => String(i).padStart(6, '0')))).toBe(false);
    expect(validateSymbols(['005930', 'invalid'])).toBe(false);
  });
});
