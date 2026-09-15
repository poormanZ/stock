import './styles/global.css';
import { WorkerApi, WorkerApiError } from './api/client';
import { sampleStocks } from './data/sampleStocks';
import { loadWatchlist } from './data/watchlist';
import { SampleQuoteProvider } from './services/sampleQuoteProvider';
import { HttpQuoteProvider, QuoteApiError } from './services/httpQuoteProvider';
import type { QuoteProvider } from './services/quoteProvider';
import { createState, savePrefs, selectedQuote, type HistoryTab, type MessageTone } from './state';
import type { StockQuote } from './types/stock';
import { renderAccount } from './views/account';
import { renderHeader } from './views/header';
import { renderHistory } from './views/history';
import { renderMarket } from './views/market';
import { renderOrderPanel } from './views/orderPanel';
import { renderSummary } from './views/summary';
import { renderTradingPanel } from './views/tradingPanel';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Application root element was not found.');
const app = root;

const API = import.meta.env.VITE_QUOTE_API_BASE_URL?.trim() ?? '';
const catalog = [...sampleStocks];
const live = Boolean(API);
const api = new WorkerApi(API);
const quoteProvider: QuoteProvider = live ? new HttpQuoteProvider(API) : new SampleQuoteProvider(catalog);
const state = createState(live, loadWatchlist(catalog));

const AUTO_REFRESH_MS = 60_000;
const AUDIT_LIMIT = 40;
const DRY_RUN_INITIAL_CASH = 10_000_000;

function describeError(error: unknown): string {
  if (error instanceof QuoteApiError) {
    if (error.code === 'KIS_RATE_LIMITED') return 'KIS 요청 제한, 잠시 후 다시 시도하세요';
    if (error.code === 'KIS_TIMEOUT') return 'KIS 응답 시간 초과';
    return '시세 API 요청 실패';
  }
  if (error instanceof WorkerApiError) {
    const known: Record<string, string> = {
      KILL_SWITCH_ACTIVE: 'Kill Switch가 켜져 있어 차단됨',
      MAX_DAILY_ORDERS: '일일 주문 횟수 한도 초과',
      MAX_DAILY_LOSS: '일일 손실 한도 초과',
      MAX_ORDER_AMOUNT: '1회 주문금액 한도(100만원) 초과',
      MAX_ORDER_QUANTITY: '1회 주문수량 한도 초과',
      MAX_POSITION_QUANTITY: '포지션 한도 초과 또는 보유 수량 부족',
      INSUFFICIENT_DRY_RUN_CASH: '가상 현금 부족',
      INSUFFICIENT_DRY_RUN_POSITION: '보유 수량 부족',
      TRADING_NOT_CONFIGURED: '자동매매 설정이 없습니다',
      EMERGENCY_STOP_ACTIVE: '긴급정지 상태입니다',
    };
    return known[error.code] ?? (error.message && error.message !== error.code ? `${error.code}: ${error.message}` : error.code);
  }
  return error instanceof Error ? error.message : '요청에 실패했습니다';
}

function setMessage(message: string, tone: MessageTone = 'info'): void {
  state.message = message;
  state.messageTone = tone;
}

/** Worker 시세에는 종목명이 없으므로 관심종목 카탈로그의 이름을 붙인다 */
function withNames(quotes: StockQuote[]): StockQuote[] {
  return quotes.map((quote) => ({ ...quote, name: state.stocks.find((s) => s.symbol === quote.symbol)?.name ?? quote.name }));
}

async function refreshAll(): Promise<void> {
  if (!live || state.busy) return;
  state.busy = true;
  setMessage('데이터 동기화 중…');
  render();
  const failures: string[] = [];
  const settle = <T>(result: PromiseSettledResult<T>, label: string, apply: (value: T) => void) => {
    if (result.status === 'fulfilled') apply(result.value);
    else failures.push(`${label}: ${describeError(result.reason)}`);
  };
  try {
    const [q, a, d, o, r, k, t, l] = await Promise.allSettled([
      quoteProvider.getQuotes(state.stocks.map((s) => s.symbol)),
      api.account(),
      api.dryRun(),
      api.orders(),
      api.reconciliation(),
      api.risk(),
      api.tradingStatus(),
      api.audit(AUDIT_LIMIT),
    ]);
    settle(q, '시세', (v) => { state.quotes = withNames(v); });
    settle(a, '계좌', (v) => { state.account = v; });
    settle(d, 'DRY_RUN', (v) => { state.dryRun = v; });
    settle(o, 'KIS 주문', (v) => { state.orderHistory = v; });
    settle(r, '대조', (v) => { state.reconciliation = v; });
    settle(k, 'Kill Switch', (v) => { state.killSwitch = v; });
    settle(t, '자동매매', (v) => { state.trading = v; });
    settle(l, '감사 로그', (v) => { state.audit = v; });

    if (!state.quotes.some((quote) => quote.symbol === state.selectedSymbol)) state.selectedSymbol = state.quotes[0]?.symbol ?? state.selectedSymbol;
    const selected = selectedQuote(state);
    if (selected && !state.limitPrice) state.limitPrice = selected.price;
    state.failures = failures;
    state.lastSync = new Date().toISOString();
    setMessage(failures.length ? '일부 데이터 동기화 실패' : '동기화 완료', failures.length ? 'bad' : 'ok');
  } finally {
    state.busy = false;
    render();
  }
}

/** 제어 동작 이후에는 상태·감사 로그만 빠르게 다시 읽는다 */
async function refreshControlState(): Promise<void> {
  const [d, k, t, l] = await Promise.allSettled([api.dryRun(), api.risk(), api.tradingStatus(), api.audit(AUDIT_LIMIT)]);
  if (d.status === 'fulfilled') state.dryRun = d.value;
  if (k.status === 'fulfilled') state.killSwitch = k.value;
  if (t.status === 'fulfilled') state.trading = t.value;
  if (l.status === 'fulfilled') state.audit = l.value;
}

async function control(label: string, action: () => Promise<string | void>, confirmText?: string): Promise<void> {
  if (!live || state.busy) return;
  if (confirmText && !confirm(confirmText)) return;
  state.busy = true;
  setMessage(`${label} 처리 중…`);
  render();
  try {
    const detail = await action();
    setMessage(detail ? `${label} 완료 · ${detail}` : `${label} 완료`, 'ok');
  } catch (error) {
    setMessage(`${label} 실패 · ${describeError(error)}`, 'bad');
  } finally {
    await refreshControlState();
    state.busy = false;
    render();
  }
}

async function submitDryRun(): Promise<void> {
  const quote = selectedQuote(state);
  const referencePrice = quote?.price ?? 0;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    setMessage('선택 종목의 유효한 시세가 필요합니다', 'bad');
    render();
    return;
  }
  const request: Record<string, unknown> = {
    id: crypto.randomUUID(),
    clientOrderId: `DRY-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: state.selectedSymbol,
    side: state.side,
    orderType: state.orderType,
    quantity: state.quantity,
    reason: 'manual',
  };
  if (state.orderType === 'limit') request.limitPrice = state.limitPrice || referencePrice;
  await control(`DRY_RUN ${state.side === 'buy' ? '매수' : '매도'}`, async () => {
    const result = await api.placeDryRunOrder({ request, referencePrice });
    const status = result.order.status === 'FILLED' ? '체결' : result.order.status === 'PARTIALLY_FILLED' ? '부분체결' : '접수(미체결)';
    return `${state.selectedSymbol} ${result.order.executedQuantity}/${result.order.quantity}주 ${status}${result.executedPrice ? ` @ ${Math.round(result.executedPrice).toLocaleString('ko-KR')}원` : ''}`;
  });
}

const resetDryRun = () => control('DRY_RUN 초기화', async () => { await api.resetDryRun(DRY_RUN_INITIAL_CASH); }, 'DRY_RUN 가상 계좌를 1,000만원으로 초기화할까요? 주문 이력도 지워집니다.');

const startTrading = () => control('자동매매 시작', async () => {
  const symbols = state.stocks.map((s) => s.symbol).slice(0, 10);
  // 설정이 없거나 종목이 바뀐 경우에만 새 설정을 보낸다. ERROR/EMERGENCY_STOP 재시작은 기존 설정을 유지한다
  const current = state.trading?.config;
  const sameConfig = current && current.mode === 'DRY_RUN' && current.symbols.join() === symbols.join();
  await api.startTrading(sameConfig ? undefined : { mode: 'DRY_RUN', symbols, strategy: { id: 'sma-crossover', params: { fast: 5, slow: 20 } }, candleBars: 60 });
}, state.trading?.status === 'EMERGENCY_STOP' || state.trading?.status === 'ERROR'
  ? '엔진을 다시 시작할까요? 원인이 해소되었는지 감사 로그에서 확인하세요.'
  : `관심종목 ${Math.min(state.stocks.length, 10)}개를 DRY_RUN 자동매매(SMA 5/20)로 시작할까요? 5분마다 KIS 시세로 평가하고 가상 주문만 냅니다.`);

const stopTrading = () => control('자동매매 정지', async () => { await api.stopTrading(); });
const runTradingNow = () => control('수동 1회 실행', async () => {
  const result = await api.runTrading() as { ran: boolean; reason?: string; run?: { status: string; orders: unknown[] } };
  return result.ran ? `${result.run?.status} · 주문 ${result.run?.orders.length ?? 0}건` : `건너뜀 (${result.reason})`;
});

const toggleKillSwitch = () => {
  const activate = !state.killSwitch?.active;
  return control(activate ? 'Kill Switch 활성화' : 'Kill Switch 해제', async () => { await api.setKillSwitch(activate, 'dashboard'); },
    activate ? '모든 신규 주문을 즉시 차단하고 자동매매를 긴급정지로 전환합니다. 계속할까요?' : 'Kill Switch를 해제할까요? 자동매매는 별도로 다시 시작해야 합니다.');
};

function selectSymbol(symbol: string): void {
  state.selectedSymbol = symbol;
  state.limitPrice = selectedQuote(state)?.price ?? state.limitPrice;
  render();
}

function persistPrefs(): void {
  savePrefs({ autoRefresh: state.autoRefresh, historyTab: state.historyTab });
}

function render(): void {
  app.innerHTML = `<main class="shell">
    ${renderHeader(state)}
    ${!live ? '<div class="notice">VITE_QUOTE_API_BASE_URL이 없어 샘플 시세 모드입니다. 주문·자동매매 제어는 비활성화됩니다.</div>' : ''}
    ${state.killSwitch?.active ? `<div class="notice danger">Kill Switch가 활성화되어 모든 신규 주문이 차단됩니다.${state.killSwitch.reason ? ` 사유: ${state.killSwitch.reason}` : ''} 자동매매 엔진은 다음 사이클에 긴급정지로 전환됩니다.</div>` : ''}
    ${renderSummary(state)}
    ${renderMarket(state)}
    <section class="layout-grid">${renderOrderPanel(state)}${renderTradingPanel(state)}</section>
    ${renderAccount(state)}
    ${renderHistory(state)}
    <footer><span>대시보드는 DRY_RUN 주문과 자동매매 제어만 수행하며 실계좌 주문 API를 호출하지 않습니다.</span><span>Kill Switch → Risk Manager → DRY_RUN Engine</span></footer>
  </main>`;
}

/** 버튼은 data-action, 입력은 data-field로 위임 처리한다. 렌더마다 리스너를 다시 붙이지 않는다 */
app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target || (target instanceof HTMLButtonElement && target.disabled)) return;
  const arg = target.dataset.arg ?? '';
  switch (target.dataset.action) {
    case 'sync': void refreshAll(); break;
    case 'toggle-auto': state.autoRefresh = !state.autoRefresh; persistPrefs(); render(); break;
    case 'select-symbol': selectSymbol(arg); break;
    case 'side': state.side = arg as 'buy' | 'sell'; render(); break;
    case 'type': state.orderType = arg as 'market' | 'limit'; render(); break;
    case 'submit-order': void submitDryRun(); break;
    case 'reset-dry': void resetDryRun(); break;
    case 'trading-start': void startTrading(); break;
    case 'trading-stop': void stopTrading(); break;
    case 'trading-run': void runTradingNow(); break;
    case 'kill-switch': void toggleKillSwitch(); break;
    case 'tab': state.historyTab = arg as HistoryTab; persistPrefs(); render(); break;
    case 'toggle-run': state.expandedRunId = state.expandedRunId === arg ? null : arg; render(); break;
    default: break;
  }
});

app.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.dataset.field === 'quantity') state.quantity = Math.max(1, Math.trunc(Number(target.value)) || 1);
  if (target.dataset.field === 'limit-price') state.limitPrice = Math.max(1, Number(target.value) || 1);
});

app.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.dataset.field === 'symbol') selectSymbol(target.value);
  // 수량·가격 입력은 포커스를 잃을 때만 미리보기를 다시 그린다
  if (target.dataset.field === 'quantity' || target.dataset.field === 'limit-price') render();
});

setInterval(() => {
  if (live && state.autoRefresh && !state.busy && document.visibilityState === 'visible') void refreshAll();
}, AUTO_REFRESH_MS);

render();
if (live) void refreshAll();
