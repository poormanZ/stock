import './styles/global.css';
import { sampleStocks } from './data/sampleStocks';
import { renderStockCard } from './components/stockCard';
import { loadWatchlist, saveWatchlist } from './data/watchlist';
import { SampleQuoteProvider } from './services/sampleQuoteProvider';
import { HttpQuoteProvider, QuoteApiError } from './services/httpQuoteProvider';
import type { QuoteProvider } from './services/quoteProvider';
import type { StockQuote } from './types/stock';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Application root element was not found.');

const catalog = [...sampleStocks];
const quoteApiBaseUrl = import.meta.env.VITE_QUOTE_API_BASE_URL?.trim() ?? '';
const quoteProvider: QuoteProvider = quoteApiBaseUrl
  ? new HttpQuoteProvider(quoteApiBaseUrl)
  : new SampleQuoteProvider(catalog);
const isLiveMode = Boolean(quoteApiBaseUrl);

let stocks = loadWatchlist(catalog);
let lastUpdated: Date | null = null;
let statusMessage = isLiveMode ? 'LIVE API · READY' : 'SAMPLE DATA · READY';
let feedbackMessage = '';
let loading = false;

function formatTime(date: Date | null): string {
  return date
    ? new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
    : '—';
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof QuoteApiError)) return '시세 API에 연결하지 못했습니다. 잠시 후 다시 시도하세요.';
  switch (error.code) {
    case 'KIS_RATE_LIMITED': return '시세 요청이 잠시 제한되었습니다. 잠시 후 다시 시도하세요.';
    case 'KIS_TIMEOUT': return '시세 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도하세요.';
    case 'INVALID_SYMBOLS': return '관심종목 요청 형식이 올바르지 않습니다.';
    default: return '시세를 가져오지 못했습니다. 잠시 후 다시 시도하세요.';
  }
}

async function refreshQuotes(): Promise<void> {
  if (loading) return;
  loading = true;
  statusMessage = isLiveMode ? 'LOADING · LIVE API' : 'LOADING · SAMPLE DATA';
  render();

  try {
    const quotes = await quoteProvider.getQuotes(stocks.map((stock) => stock.symbol));
    const catalogBySymbol = new Map(catalog.map((stock) => [stock.symbol, stock]));
    stocks = quotes.map((quote) => ({
      ...(catalogBySymbol.get(quote.symbol) ?? {}),
      ...quote,
    } as StockQuote));
    lastUpdated = new Date();
    statusMessage = isLiveMode ? 'UPDATED · LIVE API' : 'UPDATED · SAMPLE DATA';
    feedbackMessage = isLiveMode ? '실제 시세 조회가 완료되었습니다.' : '새로고침 완료 · 샘플 시세는 변경되지 않습니다.';
  } catch (error) {
    statusMessage = 'ERROR · QUOTE LOAD FAILED';
    feedbackMessage = getErrorMessage(error);
  } finally {
    loading = false;
    render();
  }
}

function render() {
  app.innerHTML = `
    <main class="shell">
      <header class="header">
        <div>
          <p class="eyebrow">MARKET MONITOR / KRX</p>
          <h1>Stock Dashboard</h1>
        </div>
        <div class="header__actions">
          <span class="status">${statusMessage}</span>
          <button class="refresh-button" id="refresh" type="button" ${loading ? 'disabled' : ''}>${loading ? '… LOADING' : '↻ REFRESH'}</button>
        </div>
      </header>

      <section class="summary" aria-label="시장 요약">
        <div><span>WATCHLIST</span><strong>${stocks.length} SYMBOLS</strong></div>
        <div><span>UPDATED</span><strong id="updated-at">${formatTime(lastUpdated)}</strong></div>
        <div><span>DATA MODE</span><strong>${isLiveMode ? 'KIS API' : 'STATIC SAMPLE'}</strong></div>
      </section>

      <section aria-labelledby="watchlist-title">
        <div class="section-heading">
          <div><p class="eyebrow">WATCHLIST</p><h2 id="watchlist-title">Manage Symbols</h2></div>
          <p class="section-heading__hint">SAMPLE CATALOG · 검색 후 관심종목에 추가</p>
        </div>
        <form class="watchlist-form" id="watchlist-form">
          <label class="search-field">
            <span class="sr-only">종목 검색</span>
            <input id="stock-search" name="stock" type="search" placeholder="종목명 또는 티커 검색 (예: 삼성전자, 005930)" autocomplete="off" />
          </label>
          <button class="add-button" type="submit">+ ADD</button>
        </form>
        <p class="form-feedback" id="form-feedback" role="status" aria-live="polite">${feedbackMessage}</p>
      </section>

      <section aria-labelledby="dashboard-title">
        <div class="section-heading">
          <div><p class="eyebrow">WATCHLIST</p><h2 id="dashboard-title">Market Overview</h2></div>
          <p class="section-heading__hint">${isLiveMode ? 'KIS API · 서버리스 Proxy 경유' : 'QuoteProvider · 샘플 데이터 모드'}</p>
        </div>
        <div class="stock-grid" id="stock-grid" aria-live="polite"></div>
      </section>

      <p class="data-note">${isLiveMode ? '실제 시세는 KIS Open API를 서버 Proxy를 통해 제공합니다. STALE/시간 미확인 시세는 자동매매 입력으로 사용하지 않습니다.' : '현재 화면은 UI 검증용 샘플 데이터입니다. 투자 판단의 근거로 사용하지 마세요.'}</p>
    </main>
  `;

  const grid = document.querySelector<HTMLDivElement>('#stock-grid');
  if (grid) {
    grid.innerHTML = loading
      ? '<div class="empty-state">LOADING QUOTES…</div>'
      : stocks.length > 0
        ? stocks.map(renderStockCard).join('')
        : '<div class="empty-state">WATCHLIST EMPTY · 종목을 검색해 추가하세요.</div>';
  }

  document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => void refreshQuotes());

  document.querySelector<HTMLFormElement>('#watchlist-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>('#stock-search');
    const query = input?.value.trim().toLowerCase() ?? '';
    if (!query) {
      feedbackMessage = '검색어를 입력하세요.';
      render();
      document.querySelector<HTMLInputElement>('#stock-search')?.focus();
      return;
    }

    const match = catalog.find((stock) => stock.symbol.toLowerCase() === query || stock.name.toLowerCase().includes(query));
    if (!match) {
      feedbackMessage = '검색 결과가 없습니다. 현재는 샘플 카탈로그의 6개 종목만 추가할 수 있습니다.';
      render();
      document.querySelector<HTMLInputElement>('#stock-search')?.focus();
      return;
    }
    if (stocks.some((stock) => stock.symbol === match.symbol)) {
      feedbackMessage = `${match.name}은(는) 이미 관심종목에 있습니다.`;
      render();
      document.querySelector<HTMLInputElement>('#stock-search')?.focus();
      return;
    }

    stocks = [...stocks, match];
    saveWatchlist(stocks);
    feedbackMessage = `${match.name} 추가 완료.`;
    statusMessage = 'WATCHLIST UPDATED';
    render();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-remove-symbol]').forEach((button) => {
    button.addEventListener('click', () => {
      const symbol = button.dataset.removeSymbol;
      const removed = stocks.find((stock) => stock.symbol === symbol);
      stocks = stocks.filter((stock) => stock.symbol !== symbol);
      saveWatchlist(stocks);
      feedbackMessage = removed ? `${removed.name} 삭제 완료.` : '종목 삭제 완료.';
      statusMessage = 'WATCHLIST UPDATED';
      render();
    });
  });
}

render();
if (isLiveMode) void refreshQuotes();
