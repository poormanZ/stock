import { esc, money, qty } from '../format';
import { selectedQuote, type AppState } from '../state';

export function renderOrderPanel(state: AppState): string {
  const quote = selectedQuote(state);
  const killed = state.killSwitch?.active === true;
  const price = state.orderType === 'limit' ? (state.limitPrice || quote?.price || 0) : (quote?.price ?? 0);
  const blocker = !state.live ? '샘플 모드에서는 주문할 수 없습니다' : killed ? 'Kill Switch가 켜져 있어 모든 주문이 차단됩니다' : !quote ? '선택 종목의 시세가 필요합니다' : state.busy ? '처리 중입니다' : '';
  const options = state.stocks.map((s) => `<option value="${s.symbol}" ${s.symbol === state.selectedSymbol ? 'selected' : ''}>${esc(s.name)} (${s.symbol})</option>`).join('');
  return `<section class="card order-panel">
    <div class="card-head"><div><p class="eyebrow">DRY_RUN</p><h2>주문 시뮬레이터</h2></div><span class="pill ${killed ? 'bad' : 'ok'}">${killed ? 'KILL SWITCH' : 'Risk Manager 적용'}</span></div>
    <p class="hint">가상 현금으로만 체결됩니다. KIS 계좌·장 운영시간과 무관하며 수수료 0.15%, 매도세 0.20%, 슬리피지 0.05%를 반영합니다.</p>
    <label>종목<select data-field="symbol">${options}</select></label>
    <div class="segmented" role="group" aria-label="매수/매도">
      <button data-action="side" data-arg="buy" class="${state.side === 'buy' ? 'active buy' : ''}">매수</button>
      <button data-action="side" data-arg="sell" class="${state.side === 'sell' ? 'active sell' : ''}">매도</button>
    </div>
    <div class="segmented" role="group" aria-label="주문 유형">
      <button data-action="type" data-arg="limit" class="${state.orderType === 'limit' ? 'active' : ''}">지정가</button>
      <button data-action="type" data-arg="market" class="${state.orderType === 'market' ? 'active' : ''}">시장가</button>
    </div>
    <div class="form-grid">
      <label>수량<input data-field="quantity" type="number" min="1" step="1" inputmode="numeric" value="${state.quantity}"></label>
      <label>${state.orderType === 'limit' ? '지정가' : '시장가 (기준 시세)'}<input data-field="limit-price" type="number" min="1" step="1" inputmode="numeric" value="${state.limitPrice || quote?.price || 0}" ${state.orderType === 'market' ? 'disabled' : ''}></label>
    </div>
    <div class="order-preview">
      <span>기준 시세 <b>${quote ? money(quote.price) : '—'}</b></span>
      <span>예상 주문금액 <b>${quote ? money(price * state.quantity) : '—'}</b></span>
      <span>수량 <b>${qty(state.quantity)}주</b></span>
    </div>
    <button class="primary ${state.side}" data-action="submit-order" ${blocker ? 'disabled' : ''} title="${esc(blocker)}">${killed ? 'KILL SWITCH · 주문 차단' : `${state.side === 'buy' ? '매수' : '매도'} 시뮬레이션 실행`}</button>
    <button class="btn ghost" data-action="reset-dry" ${!state.live || state.busy ? 'disabled' : ''}>DRY_RUN 1,000만원으로 초기화</button>
  </section>`;
}
