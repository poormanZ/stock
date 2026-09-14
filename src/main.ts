import './styles/global.css';
import { sampleStocks } from './data/sampleStocks';
import { loadWatchlist, saveWatchlist } from './data/watchlist';
import { SampleQuoteProvider } from './services/sampleQuoteProvider';
import { HttpQuoteProvider, QuoteApiError } from './services/httpQuoteProvider';
import type { QuoteProvider } from './services/quoteProvider';
import type { StockQuote } from './types/stock';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Application root element was not found.');
const app = root;
const API = import.meta.env.VITE_QUOTE_API_BASE_URL?.trim() ?? '';
const catalog = [...sampleStocks];
const quoteProvider: QuoteProvider = API ? new HttpQuoteProvider(API) : new SampleQuoteProvider(catalog);
const live = Boolean(API);

type Account = { asOf: string; environment: string; cash: number; settlementD1Cash: number; settlementD2Cash: number; totalEquity: number; netAssetValue: number; positions: { symbol: string; name?: string; quantity: number; averagePrice?: number; marketPrice?: number; evaluationAmount?: number; profitLoss?: number; profitLossPercent?: number }[] };
type DryRun = { cash: number; positions: { symbol: string; quantity: number; averagePrice: number }[]; orders: Order[]; updatedAt: string };
type Order = { id: string; clientOrderId: string; brokerOrderId?: string; symbol: string; side: 'buy' | 'sell'; orderType: 'market' | 'limit'; quantity: number; limitPrice?: number; executedQuantity: number; averageExecutedPrice: number; status: string; createdAt: string; updatedAt: string };
type OrdersResponse = { asOf: string; orders: Order[] };
type Reconciliation = { asOf?: string; matched: boolean; canPlaceNewOrders: boolean; positionMismatches: unknown[]; orderMismatches: unknown[] };

let stocks = loadWatchlist(catalog);
let quotes: StockQuote[] = [];
let account: Account | null = null;
let dryRun: DryRun | null = null;
let orderHistory: OrdersResponse | null = null;
let reconciliation: Reconciliation | null = null;
let selectedSymbol = stocks[0]?.symbol ?? '005930';
let side: 'buy' | 'sell' = 'buy';
let orderType: 'market' | 'limit' = 'limit';
let quantity = 1;
let limitPrice = 0;
let message = '';
let busy = false;

const won = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const qtyFmt = new Intl.NumberFormat('ko-KR');
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (value: number) => `${won.format(Math.round(value))}원`;
const time = (value?: string) => value ? new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : '—';

function apiError(error: unknown): string {
  if (error instanceof QuoteApiError) return error.code === 'KIS_RATE_LIMITED' ? 'KIS 요청 제한: 잠시 후 다시 시도하세요.' : error.code === 'KIS_TIMEOUT' ? 'KIS 응답 시간 초과입니다.' : 'API 요청에 실패했습니다.';
  return error instanceof Error ? error.message : '요청에 실패했습니다.';
}
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data as T;
}

async function refreshAll(): Promise<void> {
  if (!live || busy) return;
  busy = true; message = '데이터 동기화 중…'; render();
  try {
    const [q, a, d, o, r] = await Promise.all([
      quoteProvider.getQuotes(stocks.map((s) => s.symbol)),
      get<Account>('/account'), get<DryRun>('/dry-run'), get<OrdersResponse>('/orders'), get<Reconciliation>('/reconciliation'),
    ]);
    quotes = q; account = a; dryRun = d; orderHistory = o; reconciliation = r;
    if (selectedSymbol && !quotes.some((qv) => qv.symbol === selectedSymbol)) selectedSymbol = quotes[0]?.symbol ?? selectedSymbol;
    const selected = quotes.find((qv) => qv.symbol === selectedSymbol);
    if (selected && !limitPrice) limitPrice = selected.price;
    message = 'LIVE 데이터 동기화 완료';
  } catch (error) { message = apiError(error); }
  finally { busy = false; render(); }
}

async function refreshDryRun(): Promise<void> {
  if (!live) return;
  try { dryRun = await get<DryRun>('/dry-run'); render(); } catch (error) { message = apiError(error); render(); }
}

async function submitDryRun(): Promise<void> {
  if (!live || busy) return;
  const quote = quotes.find((item) => item.symbol === selectedSymbol);
  const referencePrice = quote?.price ?? 0;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) { message = '선택 종목의 유효한 시세가 필요합니다.'; render(); return; }
  const price = orderType === 'limit' ? limitPrice : undefined;
  const request: Record<string, unknown> = { id: crypto.randomUUID(), clientOrderId: `DRY-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, symbol: selectedSymbol, side, orderType, quantity };
  if (price !== undefined) request.limitPrice = price;
  busy = true; message = 'Reconciliation Gate 확인 중…'; render();
  try {
    const result = await post<{ mode: string; order: Order; cash: number }>('/dry-run/orders', { request, referencePrice });
    message = `DRY_RUN ${result.order.status} · ${selectedSymbol} ${qtyFmt.format(result.order.executedQuantity)}주`;
    await refreshDryRun();
  } catch (error) { message = apiError(error); }
  finally { busy = false; render(); }
}

async function resetDryRun(): Promise<void> {
  if (!live || !confirm('DRY_RUN 상태를 1,000만원으로 초기화할까요?')) return;
  try { dryRun = await post<DryRun>('/dry-run/reset', { initialCash: 10_000_000 }); message = 'DRY_RUN 초기화 완료'; render(); } catch (error) { message = apiError(error); render(); }
}

function positionRows(): string {
  if (!account?.positions.length) return '<tr><td colspan="5" class="empty">국내 보유 종목이 없습니다.</td></tr>';
  return account.positions.map((p) => `<tr><td>${esc(p.name || p.symbol)}</td><td>${p.symbol}</td><td>${qtyFmt.format(p.quantity)}</td><td>${money(p.averagePrice ?? 0)}</td><td>${money(p.evaluationAmount ?? 0)}</td></tr>`).join('');
}
function dryPositionRows(): string {
  if (!dryRun?.positions.length) return '<tr><td colspan="4" class="empty">DRY_RUN 보유 종목이 없습니다.</td></tr>';
  return dryRun.positions.map((p) => `<tr><td>${p.symbol}</td><td>${qtyFmt.format(p.quantity)}</td><td>${money(p.averagePrice)}</td><td>${money(p.quantity * p.averagePrice)}</td></tr>`).join('');
}
function orderRows(): string {
  const rows = [...(dryRun?.orders ?? [])].reverse().slice(0, 8);
  if (!rows.length) return '<tr><td colspan="6" class="empty">DRY_RUN 주문 이력이 없습니다.</td></tr>';
  return rows.map((o) => `<tr><td>${time(o.createdAt)}</td><td>${o.side === 'buy' ? '매수' : '매도'}</td><td>${o.symbol}</td><td>${o.orderType === 'limit' ? '지정가' : '시장가'}</td><td>${qtyFmt.format(o.executedQuantity)}/${qtyFmt.format(o.quantity)}</td><td><span class="status-pill">${o.status}</span></td></tr>`).join('');
}

function render(): void {
  const selectedQuote = quotes.find((q) => q.symbol === selectedSymbol);
  const gateOk = reconciliation?.canPlaceNewOrders === true;
  const marketCards = quotes.length ? quotes.map((q) => `<button class="quote-card ${q.symbol === selectedSymbol ? 'selected' : ''}" data-select="${q.symbol}"><div><b>${esc(q.name)}</b><small>${q.symbol} · ${q.market}</small></div><strong>${money(q.price)}</strong><span class="change ${q.change >= 0 ? 'up' : 'down'}">${q.change >= 0 ? '+' : ''}${won.format(q.change)} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%)</span></button>`).join('') : '<div class="empty-box">시세 데이터가 없습니다.</div>';
  const options = stocks.map((s) => `<option value="${s.symbol}" ${s.symbol === selectedSymbol ? 'selected' : ''}>${esc(s.name)} (${s.symbol})</option>`).join('');
  app.innerHTML = `<main class="shell">
    <header class="topbar"><div><p class="eyebrow">KIS / AUTO TRADING CONSOLE</p><h1>STOCK CONTROL</h1><p class="sub">시세 · 계좌 · DRY_RUN 주문 통합 대시보드</p></div><div class="top-actions"><span class="mode ${live ? 'live' : ''}">${live ? '● LIVE API' : '○ SAMPLE MODE'}</span><button id="refresh" class="btn">${busy ? 'SYNC…' : '↻ SYNC'}</button></div></header>
    ${!live ? '<div class="notice">VITE_QUOTE_API_BASE_URL이 없어 샘플 시세 모드입니다. GitHub Pages 배포에서는 production 환경변수를 사용합니다.</div>' : ''}
    <section class="quotes"><div class="section-title"><div><p class="eyebrow">MARKET</p><h2>관심종목</h2></div><span>선택 종목을 주문 패널에서 사용</span></div><div class="quote-grid">${marketCards}</div></section>
    <section class="layout-grid">
      <div class="panel account"><div class="section-title"><div><p class="eyebrow">ACCOUNT / LIVE</p><h2>계좌 현황</h2></div><span>${account ? time(account.asOf) : '—'}</span></div><div class="metric-grid"><div><small>국내 주문가능 현금</small><b>${account ? money(account.cash) : '—'}</b></div><div><small>총 평가/순자산</small><b>${account ? money(account.totalEquity || account.netAssetValue) : '—'}</b></div><div><small>정산 D+1</small><b>${account ? money(account.settlementD1Cash) : '—'}</b></div><div><small>정산 D+2</small><b>${account ? money(account.settlementD2Cash) : '—'}</b></div></div><div class="table-wrap"><table><thead><tr><th>종목</th><th>코드</th><th>수량</th><th>평균단가</th><th>평가금액</th></tr></thead><tbody>${positionRows()}</tbody></table></div></div>
      <div class="panel order-panel"><div class="section-title"><div><p class="eyebrow">DRY_RUN</p><h2>주문 시뮬레이터</h2></div><span class="gate ${gateOk ? 'ok' : 'blocked'}">GATE ${gateOk ? 'READY' : 'BLOCKED'}</span></div><label>종목<select id="symbol">${options}</select></label><div class="segmented"><button data-side="buy" class="${side === 'buy' ? 'active' : ''}">매수</button><button data-side="sell" class="${side === 'sell' ? 'active' : ''}">매도</button></div><div class="segmented"><button data-type="limit" class="${orderType === 'limit' ? 'active' : ''}">지정가</button><button data-type="market" class="${orderType === 'market' ? 'active' : ''}">시장가</button></div><div class="form-grid"><label>수량<input id="quantity" type="number" min="1" step="1" value="${quantity}"></label><label>가격<input id="limit-price" type="number" min="1" step="1" value="${limitPrice || selectedQuote?.price || 0}" ${orderType === 'market' ? 'disabled' : ''}></label></div><div class="order-preview"><span>기준 시세 <b>${selectedQuote ? money(selectedQuote.price) : '—'}</b></span><span>예상 주문금액 <b>${selectedQuote ? money((orderType === 'limit' ? limitPrice : selectedQuote.price) * quantity) : '—'}</b></span></div><button id="submit-order" class="primary" ${busy || !gateOk ? 'disabled' : ''}>${gateOk ? 'DRY_RUN 주문 실행' : 'RECONCILIATION 불일치 · 주문 차단'}</button><button id="reset-dry" class="btn ghost">DRY_RUN 1,000만원 초기화</button><p class="message" role="status">${esc(message)}</p></div>
    </section>
    <section class="layout-grid lower"><div class="panel"><div class="section-title"><div><p class="eyebrow">DRY_RUN STATE</p><h2>가상 포지션</h2></div><b class="cash">${dryRun ? money(dryRun.cash) : '—'}</b></div><div class="table-wrap"><table><thead><tr><th>코드</th><th>수량</th><th>평균단가</th><th>평가 기준금액</th></tr></thead><tbody>${dryPositionRows()}</tbody></table></div></div><div class="panel"><div class="section-title"><div><p class="eyebrow">ORDER LOG</p><h2>DRY_RUN 주문 이력</h2></div><span>최근 8건</span></div><div class="table-wrap"><table><thead><tr><th>시간</th><th>구분</th><th>코드</th><th>유형</th><th>체결</th><th>상태</th></tr></thead><tbody>${orderRows()}</tbody></table></div></div></section>
    <footer><span>실제 KIS 주문 API는 호출하지 않습니다.</span><span>Reconciliation Gate → DRY_RUN Engine</span></footer>
  </main>`;

  document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => void refreshAll());
  document.querySelector<HTMLButtonElement>('#submit-order')?.addEventListener('click', () => void submitDryRun());
  document.querySelector<HTMLButtonElement>('#reset-dry')?.addEventListener('click', () => void resetDryRun());
  document.querySelector<HTMLSelectElement>('#symbol')?.addEventListener('change', (e) => { selectedSymbol = (e.target as HTMLSelectElement).value; const q = quotes.find((item) => item.symbol === selectedSymbol); limitPrice = q?.price ?? limitPrice; render(); });
  document.querySelector<HTMLInputElement>('#quantity')?.addEventListener('input', (e) => { quantity = Math.max(1, Number((e.target as HTMLInputElement).value) || 1); });
  document.querySelector<HTMLInputElement>('#limit-price')?.addEventListener('input', (e) => { limitPrice = Math.max(1, Number((e.target as HTMLInputElement).value) || 1); });
  document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach((b) => b.addEventListener('click', () => { side = b.dataset.side as 'buy' | 'sell'; render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((b) => b.addEventListener('click', () => { orderType = b.dataset.type as 'market' | 'limit'; render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-select]').forEach((b) => b.addEventListener('click', () => { selectedSymbol = b.dataset.select!; const q = quotes.find((item) => item.symbol === selectedSymbol); limitPrice = q?.price ?? limitPrice; render(); }));
}

render();
if (live) void refreshAll();
