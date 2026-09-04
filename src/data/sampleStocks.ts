import type { StockQuote } from '../types/stock';

export const sampleStocks: StockQuote[] = [
  { symbol: '005930', name: '삼성전자', market: 'KOSPI', price: 158700, change: 2100, changePercent: 1.34, volume: 18420000, marketStatus: 'OPEN', asOf: '2026-09-04 19:00', source: 'SAMPLE DATA', delayed: true },
  { symbol: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 312500, change: -3500, changePercent: -1.11, volume: 5210000, marketStatus: 'OPEN', asOf: '2026-09-04 19:00', source: 'SAMPLE DATA', delayed: true },
  { symbol: '005380', name: '현대차', market: 'KOSPI', price: 238000, change: 4500, changePercent: 1.93, volume: 1930000, marketStatus: 'OPEN', asOf: '2026-09-04 19:00', source: 'SAMPLE DATA', delayed: true },
  { symbol: '035420', name: 'NAVER', market: 'KOSPI', price: 264500, change: 1500, changePercent: 0.57, volume: 880000, marketStatus: 'OPEN', asOf: '2026-09-04 19:00', source: 'SAMPLE DATA', delayed: true },
  { symbol: '035720', name: '카카오', market: 'KOSPI', price: 61100, change: -900, changePercent: -1.45, volume: 2740000, marketStatus: 'OPEN', asOf: '2026-09-04 19:00', source: 'SAMPLE DATA', delayed: true },
  { symbol: '068270', name: '셀트리온', market: 'KOSPI', price: 184200, change: 2800, changePercent: 1.54, volume: 1190000, marketStatus: 'OPEN', asOf: '2026-09-04 19:00', source: 'SAMPLE DATA', delayed: true },
];
