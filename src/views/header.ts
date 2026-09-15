import { ago, esc, tone, tradingStatusLabel } from '../format';
import type { AppState } from '../state';

export function renderHeader(state: AppState): string {
  const engine = state.trading?.status;
  const killed = state.killSwitch?.active === true;
  return `<header class="topbar">
    <div class="brand">
      <p class="eyebrow">KIS / AUTO TRADING CONSOLE</p>
      <h1>STOCK CONTROL</h1>
      <p class="sub">시세 · 계좌 · DRY_RUN 주문 · 자동매매 대시보드</p>
    </div>
    <div class="status-strip" aria-label="시스템 상태">
      <span class="pill ${state.live ? 'ok' : 'neutral'}" title="${state.live ? 'Worker API에 연결됨' : 'VITE_QUOTE_API_BASE_URL 없음'}">${state.live ? '● LIVE API' : '○ SAMPLE'}</span>
      <span class="pill ${engine ? tone(engine) : 'neutral'}" title="자동매매 엔진 상태">엔진 ${engine ? esc(tradingStatusLabel(engine)) : '—'}</span>
      <span class="pill ${killed ? 'bad' : 'ok'}" title="${killed ? `사유: ${esc(state.killSwitch?.reason ?? 'manual')}` : '모든 주문 경로 정상'}">${killed ? '■ KILL SWITCH ON' : 'KILL SWITCH OFF'}</span>
      <span class="pill neutral" title="마지막 동기화">${state.lastSync ? `동기화 ${ago(state.lastSync)}` : '동기화 전'}</span>
      <button class="btn small ${state.autoRefresh ? 'active' : ''}" data-action="toggle-auto" title="60초마다 자동 새로고침">${state.autoRefresh ? '자동 새로고침 ON' : '자동 새로고침 OFF'}</button>
      <button class="btn small" data-action="sync" ${state.busy ? 'disabled' : ''}>${state.busy ? '동기화 중…' : '↻ 지금 동기화'}</button>
    </div>
  </header>
  <p class="message ${state.messageTone}" role="status">${esc(state.message)}${state.failures.length ? `<span class="failures"> · ${state.failures.map(esc).join(' / ')}</span>` : ''}</p>`;
}
