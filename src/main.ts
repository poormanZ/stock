import './styles/global.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Application root element was not found.');
}

app.innerHTML = `
  <main class="shell">
    <header class="header">
      <div>
        <p class="eyebrow">MARKET MONITOR</p>
        <h1>Stock Dashboard</h1>
      </div>
      <span class="status">PHASE 0 · READY</span>
    </header>
    <section class="placeholder" aria-labelledby="next-step-title">
      <p class="placeholder__label">PLATFORM FOUNDATION</p>
      <h2 id="next-step-title">여러 종목을 한 화면에서 확인하세요.</h2>
      <p>웹 프로젝트와 GitHub Pages 배포 기반이 준비되었습니다. 다음 단계에서 샘플 주가 카드와 관심종목 화면을 구현합니다.</p>
    </section>
  </main>
`;
