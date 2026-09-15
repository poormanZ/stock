import { esc, money, signedMoney, time, tone, tradingStatusLabel } from '../format';
import type { AppState } from '../state';

function tile(label: string, value: string, hint = '', toneClass = ''): string {
  return `<div class="tile ${toneClass}"><small>${label}</small><b>${value}</b>${hint ? `<span>${hint}</span>` : ''}</div>`;
}

/** 한눈에 봐야 하는 6가지: 엔진, DRY_RUN 현금, 당일 실현손익, 계좌 현금, 대조 상태, 최근 실행 */
export function renderSummary(state: AppState): string {
  const { trading, dryRun, account, reconciliation } = state;
  const last = trading?.lastRun;
  const realized = dryRun?.realized;
  const recon = reconciliation ? (reconciliation.canPlaceNewOrders ? 'MATCHED' : 'MISMATCHED') : null;
  return `<section class="summary">
    ${tile('자동매매 엔진', trading ? esc(tradingStatusLabel(trading.status)) : '—', trading?.config ? `${esc(trading.config.mode)} · ${trading.config.symbols.length}종목 · ${esc(trading.config.strategy.id)}` : '설정 없음', trading ? tone(trading.status) : '')}
    ${tile('DRY_RUN 가상 현금', dryRun ? money(dryRun.cash) : '—', dryRun ? `포지션 ${dryRun.positions.length}종목 · 주문 ${dryRun.orders.length}건` : '')}
    ${tile('DRY_RUN 당일 실현손익', realized ? signedMoney(realized.pnl) : '0원', realized ? `${realized.date.slice(4, 6)}/${realized.date.slice(6, 8)} 기준` : '매도 체결 없음', realized ? (realized.pnl < 0 ? 'bad' : realized.pnl > 0 ? 'ok' : '') : '')}
    ${tile(`계좌 주문가능 현금 (${esc(account?.environment ?? 'LIVE')})`, account ? money(account.cash) : '—', account ? `총 평가 ${money(account.totalEquity || account.netAssetValue)} · ${time(account.asOf)}` : '')}
    ${tile('KIS ↔ 내부 대조', recon ? (recon === 'MATCHED' ? '일치' : `불일치 ${reconciliation!.differences.length}건`) : '—', 'PAPER/LIVE 주문 게이트에만 적용', recon ? tone(recon) : '')}
    ${tile('최근 자동매매 실행', last ? `${esc(last.status)}${last.reason ? ` · ${esc(last.reason)}` : ''}` : '—', last ? `${time(last.startedAt)} · 신호 ${last.signals.filter((s) => s.action !== 'hold').length} · 주문 ${last.orders.length}` : '실행 이력 없음', last ? tone(last.status) : '')}
  </section>`;
}
