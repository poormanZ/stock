import './styles/global.css';
import { sampleStocks } from './data/sampleStocks';
import { renderStockCard } from './components/stockCard';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Application root element was not found.');

let stocks = [...sampleStocks];
let lastUpdated = new Date();

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

function render(statusMessage = 'SAMPLE DATA · READY') {
  app.innerHTML = `
    <main class="shell">
      <header class="header">
        <div>
          <p class="eyebrow">MARKET MONITOR / KRX</p>
          <h1>Stock Dashboard</h1>
        </div>
        <div class="header__actions">
          <span class="status">${statusMessage}</span>
          <button class="refresh-button" id="refresh" type="button">↻ REFRESH</button>
        </div>
      </header>

      <section class="summary" aria-label="시장 요약">
        <div><span>WATCHLIST</span><strong>${stocks.length} SYMBOLS</strong></div>
        <div><span>UPDATED</span><strong id="updated-at">${formatTime(lastUpdated)}</strong></div>
        <div><span>DATA MODE</span><strong>STATIC SAMPLE</strong></div>
      </section>

      <section aria-labelledby="dashboard-title">
        <div class="section-heading">
          <div><p class="eyebrow">WATCHLIST</p><h2 id="dashboard-title">Market Overview</h2></div>
          <p class="section-heading__hint">샘플 데이터 · 실제 시세 API는 Phase 3에서 연결</p>
        </div>
        <div class="stock-grid" id="stock-grid" aria-live="polite"></div>
      </section>

      <p class="data-note">현재 화면은 UI 검증용 샘플 데이터입니다. 투자 판단의 근거로 사용하지 마세요.</p>
    </main>
  `;

  const grid = document.querySelector<HTMLDivElement>('#stock-grid');
  if (!grid) return;
  grid.innerHTML = stocks.map(renderStockCard).join('');
  document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => {
    lastUpdated = new Date();
    render('REFRESHED · SAMPLE DATA');
  });
}

render();
