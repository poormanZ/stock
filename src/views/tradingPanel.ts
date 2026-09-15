import { describeReason, esc, sideLabel, time, tone, tradingStatusLabel } from '../format';
import type { AppState } from '../state';
import { findPreset, STRATEGY_PRESETS } from '../strategies';

export function renderTradingPanel(state: AppState): string {
  const { trading, killSwitch, live, busy } = state;
  const status = trading?.status ?? 'STOPPED';
  const killed = killSwitch?.active === true;
  const cfg = trading?.config;
  const last = trading?.lastRun;
  const canStart = live && !busy && status !== 'RUNNING' && !killed;
  const preset = findPreset(state.strategyPreset);
  const startLabel = status === 'EMERGENCY_STOP' ? '긴급정지 해제 후 재시작' : status === 'ERROR' ? '오류 확인 후 재시작' : 'DRY_RUN 자동매매 시작';
  const startHint = !live ? '샘플 모드' : killed ? 'Kill Switch를 먼저 해제하세요' : status === 'RUNNING' ? '이미 실행 중입니다' : `관심종목을 "${preset.label}" DRY_RUN으로 5분마다 평가합니다`;
  const presetOptions = STRATEGY_PRESETS.map((p) => `<option value="${p.id}" ${p.id === preset.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  const lastOrders = last?.orders.length
    ? `<ul class="reason-list">${last.orders.map((o) => `<li><b class="${o.side}">${sideLabel(o.side)}</b> ${esc(o.symbol)} ${o.quantity}주 → ${esc(o.result)}<small>${esc(describeReason(o.reason))}</small></li>`).join('')}</ul>`
    : '';
  return `<section class="card">
    <div class="card-head"><div><p class="eyebrow">AUTO TRADING / ${esc(cfg?.mode ?? 'DRY_RUN')}</p><h2>자동매매 엔진</h2></div><span class="pill ${tone(status)}">${esc(tradingStatusLabel(status))}</span></div>
    <dl class="kv">
      <div><dt>전략</dt><dd>${cfg ? `${esc(cfg.strategy.id)} <small>${esc(JSON.stringify(cfg.strategy.params))}</small>` : '—'}</dd></div>
      <div><dt>종목</dt><dd>${cfg ? esc(cfg.symbols.join(', ')) : '—'}</dd></div>
      <div><dt>청산 규칙</dt><dd>${cfg ? [cfg.exit.stopLossPct ? `손절 -${cfg.exit.stopLossPct}%` : '', cfg.exit.takeProfitPct ? `익절 +${cfg.exit.takeProfitPct}%` : '', cfg.exit.trailingStopPct ? `트레일링 -${cfg.exit.trailingStopPct}%` : ''].filter(Boolean).join(' · ') || '전략 신호만' : '—'}</dd></div>
      <div><dt>최근 실행</dt><dd>${last ? `${time(last.startedAt)} · ${last.trigger === 'cron' ? '자동' : '수동'} · <span class="pill mini ${tone(last.status)}">${esc(last.status)}</span>${last.reason ? ` ${esc(describeReason(last.reason))}` : ''}${last.error ? `<small class="down">${esc(last.error.source)}: ${esc(last.error.message)}</small>` : ''}` : '실행 이력 없음'}</dd></div>
      ${trading?.error ? `<div><dt>오류</dt><dd class="down">${esc(trading.error)}</dd></div>` : ''}
    </dl>
    ${lastOrders}
    <label class="preset">시작할 전략 프리셋<select data-field="strategy-preset" ${status === 'RUNNING' ? 'disabled' : ''}>${presetOptions}</select><small>${esc(preset.summary)}</small></label>
    <div class="segmented">
      <button data-action="trading-start" ${canStart ? '' : 'disabled'} title="${esc(startHint)}">${startLabel}</button>
      <button data-action="trading-stop" ${live && !busy && status === 'RUNNING' ? '' : 'disabled'}>정지</button>
    </div>
    <div class="segmented">
      <button data-action="trading-run" ${live && !busy && status === 'RUNNING' ? '' : 'disabled'} title="cron과 같은 경로로 지금 1회 평가합니다">지금 1회 실행</button>
      <button data-action="kill-switch" class="${killed ? 'active bad' : 'danger'}" ${live && !busy ? '' : 'disabled'} title="${killed ? '모든 주문 차단을 해제합니다' : '모든 신규 주문을 즉시 차단합니다'}">${killed ? 'KILL SWITCH 해제' : 'KILL SWITCH'}</button>
    </div>
    <p class="hint">PAPER/LIVE 자동 실행은 대시보드에서 시작하지 않습니다. 스케줄: KST 평일 09:00~15:59, 5분 간격. 하루에 종목·방향별 1회만 주문합니다.</p>
  </section>`;
}
