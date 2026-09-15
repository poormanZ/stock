import { esc, money, pct, qty, signedMoney, time } from '../format';
import type { AppState } from '../state';

export function renderAccount(state: AppState): string {
  const { account, reconciliation } = state;
  const rows = account?.positions.length
    ? account.positions.map((p) => `<tr><td>${esc(p.name || p.symbol)}<small>${p.symbol}</small></td><td>${qty(p.quantity)}</td><td>${money(p.averagePrice ?? 0)}</td><td>${money(p.currentPrice ?? 0)}</td><td>${money(p.evaluationAmount ?? 0)}</td><td class="${(p.profitLossAmount ?? 0) > 0 ? 'up' : (p.profitLossAmount ?? 0) < 0 ? 'down' : ''}">${signedMoney(p.profitLossAmount ?? 0)}<small>${pct(p.profitLossPercent ?? 0)}</small></td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">${account ? '국내 보유 종목이 없습니다.' : '계좌 정보를 아직 받지 못했습니다.'}</td></tr>`;
  const recon = reconciliation
    ? `<span class="pill ${reconciliation.canPlaceNewOrders ? 'ok' : 'bad'}" title="KIS 계좌/주문과 내부 상태 대조. PAPER/LIVE 신규 주문에만 적용되며 DRY_RUN은 차단하지 않습니다.">대조 ${reconciliation.canPlaceNewOrders ? '일치' : `불일치 ${reconciliation.differences.length}건`}</span>`
    : '';
  const differences = reconciliation && !reconciliation.canPlaceNewOrders
    ? `<ul class="diff-list">${reconciliation.differences.slice(0, 5).map((d) => `<li>${esc(d.message)}</li>`).join('')}${reconciliation.differences.length > 5 ? `<li>… 외 ${reconciliation.differences.length - 5}건</li>` : ''}</ul>`
    : '';
  return `<section class="card">
    <div class="card-head"><div><p class="eyebrow">ACCOUNT / ${esc(account?.environment ?? 'LIVE')}</p><h2>계좌 현황</h2></div><span class="hint">${account ? `조회 ${time(account.asOf)}` : ''} ${recon}</span></div>
    <div class="metric-grid">
      <div><small>주문가능 현금</small><b>${account ? money(account.cash) : '—'}</b></div>
      <div><small>총 평가 / 순자산</small><b>${account ? money(account.totalEquity || account.netAssetValue) : '—'}</b></div>
      <div><small>정산 D+1</small><b>${account ? money(account.settlementD1Cash) : '—'}</b></div>
      <div><small>정산 D+2</small><b>${account ? money(account.settlementD2Cash) : '—'}</b></div>
    </div>
    ${differences}
    <div class="table-wrap"><table><thead><tr><th>종목</th><th>수량</th><th>평균단가</th><th>현재가</th><th>평가금액</th><th>평가손익</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}
