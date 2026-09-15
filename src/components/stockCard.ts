import type { StockQuote } from '../types/stock';
import { getQuoteDirection } from '../types/stock';
import { formatAsOf, getQuoteFreshness } from '../services/quoteFreshness';

const formatPrice = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const formatVolume = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });

const freshnessLabel: Record<ReturnType<typeof getQuoteFreshness>, string> = {
  FRESH: 'FRESH',
  STALE: 'STALE',
  TIME_UNKNOWN: 'TIME UNKNOWN',
  CLOSED: 'CLOSED',
  INVALID_TIME: 'TIME INVALID',
};

export function renderStockCard(quote: StockQuote): string {
  const direction = getQuoteDirection(quote.change);
  const sign = quote.change > 0 ? '+' : '';
  const directionLabel = direction === 'up' ? '상승' : direction === 'down' ? '하락' : '보합';
  const freshness = getQuoteFreshness(quote);
  const freshnessText = freshnessLabel[freshness];

  return `
    <article class="stock-card stock-card--${direction}" aria-label="${quote.name} ${directionLabel}">
      <div class="stock-card__top">
        <div>
          <h3>${quote.name}</h3>
          <p>${quote.symbol} · ${quote.market}</p>
        </div>
        <div class="stock-card__actions">
          <span class="market-badge market-badge--${quote.marketStatus.toLowerCase()}">${quote.marketStatus}</span>
          <button class="remove-button" type="button" data-remove-symbol="${quote.symbol}" aria-label="${quote.name} 관심종목에서 삭제">×</button>
        </div>
      </div>
      <div class="stock-card__price">${formatPrice.format(quote.price)}<span>원</span></div>
      <div class="stock-card__change" aria-label="전일 대비 ${sign}${formatPrice.format(quote.change)}원, ${sign}${quote.changePercent.toFixed(2)}퍼센트">
        ${sign}${formatPrice.format(quote.change)}원 <strong>${sign}${quote.changePercent.toFixed(2)}%</strong>
      </div>
      <dl class="stock-card__meta">
        <div><dt>VOLUME</dt><dd>${formatVolume.format(quote.volume)}</dd></div>
        <div><dt>AS OF</dt><dd>${formatAsOf(quote.asOf)}</dd></div>
      </dl>
      <div class="freshness freshness--${freshness.toLowerCase()}" role="status">${freshnessText}</div>
      <footer>${quote.source}${quote.delayed ? ' · DELAYED' : ''}</footer>
    </article>
  `;
}
