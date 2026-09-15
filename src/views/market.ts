import { ago, esc, money, pct, qty } from '../format';
import { getQuoteFreshness } from '../services/quoteFreshness';
import type { AppState } from '../state';

const FRESHNESS_LABEL: Record<string, string> = { FRESH: '최신', STALE: '지연', TIME_UNKNOWN: '시각 미확인', CLOSED: '장 마감', INVALID_TIME: '시각 오류' };

export function renderMarket(state: AppState): string {
  const cards = state.quotes.length
    ? state.quotes.map((q) => {
      const up = q.change > 0;
      const down = q.change < 0;
      const freshness = getQuoteFreshness(q);
      return `<button class="quote-card ${q.symbol === state.selectedSymbol ? 'selected' : ''}" data-action="select-symbol" data-arg="${q.symbol}" aria-pressed="${q.symbol === state.selectedSymbol}" title="클릭하면 주문 패널의 종목으로 선택됩니다">
        <div class="quote-head"><b>${esc(q.name)}</b><small>${q.symbol} · ${esc(q.market)}</small></div>
        <strong class="${up ? 'up' : down ? 'down' : ''}">${money(q.price)}</strong>
        <span class="change ${up ? 'up' : down ? 'down' : ''}">${up ? '▲' : down ? '▼' : '—'} ${qty(Math.abs(q.change))} (${pct(q.changePercent)})</span>
        <small class="meta">거래량 ${qty(q.volume)} · <span class="dot ${freshness === 'FRESH' ? 'ok' : freshness === 'STALE' ? 'bad' : 'neutral'}"></span>${FRESHNESS_LABEL[freshness] ?? freshness}${q.fetchedAt ? ` · ${ago(q.fetchedAt)}` : ''}</small>
      </button>`;
    }).join('')
    : `<div class="empty-box">${state.live ? '시세를 아직 받지 못했습니다. 동기화를 눌러 주세요.' : '샘플 모드: 시세 데이터가 없습니다.'}</div>`;
  return `<section class="card">
    <div class="card-head"><div><p class="eyebrow">MARKET</p><h2>관심종목</h2></div><span class="hint">카드를 클릭하면 주문 패널의 종목이 바뀝니다</span></div>
    <div class="quote-grid">${cards}</div>
  </section>`;
}
