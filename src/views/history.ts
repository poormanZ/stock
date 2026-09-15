import { auditTypeLabel, dateTime, describeReason, esc, money, orderStatusLabel, qty, sideLabel, time, tone } from '../format';
import type { AppState, HistoryTab } from '../state';

const TABS: { id: HistoryTab; label: string }[] = [
  { id: 'dry-run', label: 'DRY_RUN 주문' },
  { id: 'runs', label: '자동매매 실행' },
  { id: 'audit', label: '감사 로그' },
  { id: 'kis', label: 'KIS 당일 주문' },
];

function pill(status: string, label = status): string {
  return `<span class="pill mini ${tone(status)}">${esc(label)}</span>`;
}

function dryRunRows(state: AppState): string {
  const rows = [...(state.dryRun?.orders ?? [])].reverse().slice(0, 30);
  if (!rows.length) return '<tr><td colspan="7" class="empty">DRY_RUN 주문 이력이 없습니다.</td></tr>';
  return rows.map((o) => `<tr>
    <td>${dateTime(o.createdAt)}</td>
    <td><b class="${o.side}">${sideLabel(o.side)}</b></td>
    <td>${esc(state.stocks.find((s) => s.symbol === o.symbol)?.name ?? o.symbol)}<small>${esc(o.symbol)}</small></td>
    <td>${o.orderType === 'limit' ? `지정가 ${money(o.limitPrice ?? 0)}` : '시장가'}</td>
    <td>${qty(o.executedQuantity)}/${qty(o.quantity)}${o.averageExecutedPrice ? `<small>@ ${money(o.averageExecutedPrice)}</small>` : ''}</td>
    <td class="wrap">${o.reason ? esc(describeReason(o.reason)) : (o.clientOrderId.startsWith('AUTO-') ? '자동매매' : '수동 주문')}</td>
    <td>${pill(o.status, orderStatusLabel(o.status))}</td>
  </tr>`).join('');
}

function runRows(state: AppState): string {
  const runs = [...(state.trading?.runs ?? [])].reverse().slice(0, 30);
  if (!runs.length) return '<tr><td colspan="6" class="empty">자동매매 실행 이력이 없습니다. 엔진을 시작하면 5분마다 기록됩니다.</td></tr>';
  return runs.map((r) => {
    const acted = r.signals.filter((s) => s.action !== 'hold');
    const expanded = state.expandedRunId === r.id;
    const detail = expanded ? `<tr class="detail"><td colspan="6">
      <div class="detail-grid">
        <div><h4>신호</h4>${r.signals.length ? `<ul class="reason-list">${r.signals.map((s) => `<li><b class="${s.action}">${sideLabel(s.action)}</b> ${esc(s.symbol)}${s.price ? ` @ ${money(s.price)}` : ''}<small>${esc(describeReason(s.reason))}</small></li>`).join('')}</ul>` : '<p class="empty">평가된 종목 없음</p>'}</div>
        <div><h4>주문</h4>${r.orders.length ? `<ul class="reason-list">${r.orders.map((o) => `<li><b class="${o.side}">${sideLabel(o.side)}</b> ${esc(o.symbol)} ${qty(o.quantity)}주 → ${pill(String(o.result), esc(describeReason(String(o.result))))}<small>${esc(describeReason(o.reason))}</small></li>`).join('')}</ul>` : '<p class="empty">주문 없음</p>'}${r.error ? `<p class="down">${esc(r.error.source)}: ${esc(r.error.message)}</p>` : ''}</div>
      </div></td></tr>` : '';
    return `<tr class="clickable" data-action="toggle-run" data-arg="${r.id}" title="클릭하면 신호와 주문 사유를 펼칩니다">
      <td>${dateTime(r.startedAt)}</td>
      <td>${r.trigger === 'cron' ? '자동' : '수동'}</td>
      <td>${pill(r.status)}${r.reason ? `<small>${esc(describeReason(r.reason))}</small>` : ''}</td>
      <td>${acted.length ? acted.map((s) => `<b class="${s.action}">${sideLabel(s.action)}</b> ${esc(s.symbol)}`).join(', ') : `관망 ${r.signals.length}종목`}</td>
      <td>${r.orders.length ? r.orders.map((o) => `${sideLabel(o.side)} ${esc(o.symbol)} ${qty(o.quantity)}주 (${esc(describeReason(String(o.result)))})`).join(', ') : '—'}</td>
      <td class="wrap">${r.error ? `<span class="down">${esc(r.error.source)}: ${esc(r.error.message)}</span>` : acted.map((s) => esc(describeReason(s.reason))).join(' / ') || '—'}</td>
    </tr>${detail}`;
  }).join('');
}

function auditRows(state: AppState): string {
  const rows = state.audit?.events ?? [];
  if (!rows.length) return '<tr><td colspan="4" class="empty">감사 이벤트가 없습니다.</td></tr>';
  return rows.map((e) => `<tr><td>${dateTime(e.at)}</td><td>${pill(e.type, auditTypeLabel(e.type))}</td><td>${esc(e.mode)}${e.symbol ? `<small>${esc(e.symbol)}</small>` : ''}</td><td class="wrap">${esc(e.message)}</td></tr>`).join('');
}

function kisRows(state: AppState): string {
  const rows = state.orderHistory?.orders ?? [];
  if (!rows.length) return '<tr><td colspan="6" class="empty">KIS 당일 주문 내역이 없습니다.</td></tr>';
  return rows.map((o) => `<tr><td>${esc(o.orderTime.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1:$2:$3'))}</td><td><b class="${o.side}">${sideLabel(o.side)}</b></td><td>${esc(o.name || o.symbol)}<small>${esc(o.symbol)}</small></td><td>${esc(o.orderType)} ${o.orderPrice ? money(o.orderPrice) : ''}</td><td>${qty(o.executedQuantity)}/${qty(o.quantity)}${o.averageExecutedPrice ? `<small>@ ${money(o.averageExecutedPrice)}</small>` : ''}</td><td>${pill(o.status, orderStatusLabel(o.status))}</td></tr>`).join('');
}

export function renderHistory(state: AppState): string {
  const counts: Record<HistoryTab, number> = {
    'dry-run': state.dryRun?.orders.length ?? 0,
    runs: state.trading?.runs.length ?? 0,
    audit: state.audit?.count ?? 0,
    kis: state.orderHistory?.orders.length ?? 0,
  };
  const tabs = TABS.map((t) => `<button role="tab" aria-selected="${state.historyTab === t.id}" class="${state.historyTab === t.id ? 'active' : ''}" data-action="tab" data-arg="${t.id}">${t.label}<small>${counts[t.id]}</small></button>`).join('');
  const table = state.historyTab === 'dry-run'
    ? `<thead><tr><th>시간</th><th>구분</th><th>종목</th><th>유형</th><th>체결/수량</th><th>사유</th><th>상태</th></tr></thead><tbody>${dryRunRows(state)}</tbody>`
    : state.historyTab === 'runs'
      ? `<thead><tr><th>시간</th><th>트리거</th><th>결과</th><th>신호</th><th>주문</th><th>사유</th></tr></thead><tbody>${runRows(state)}</tbody>`
      : state.historyTab === 'audit'
        ? `<thead><tr><th>시간</th><th>유형</th><th>모드</th><th>내용</th></tr></thead><tbody>${auditRows(state)}</tbody>`
        : `<thead><tr><th>시간</th><th>구분</th><th>종목</th><th>유형</th><th>체결/수량</th><th>상태</th></tr></thead><tbody>${kisRows(state)}</tbody>`;
  const legend = state.historyTab === 'runs' ? '<span class="hint">행을 클릭하면 종목별 신호와 매수/매도 사유가 펼쳐집니다.</span>' : state.historyTab === 'dry-run' ? '<span class="hint">사유 열은 자동매매 신호(예: 5일선이 20일선을 상향 돌파, 손절)나 수동 주문 여부를 보여줍니다.</span>' : '';
  return `<section class="card">
    <div class="card-head"><div><p class="eyebrow">HISTORY</p><h2>이력</h2></div>${legend}</div>
    <div class="tabs" role="tablist">${tabs}</div>
    <div class="table-wrap"><table>${table}</table></div>
  </section>`;
}
