# 한국투자증권 자동 주식매매 시스템

`poormanZ/stock`은 한국투자증권(KIS) Open API를 기반으로 하는 웹 주식 대시보드 및 자동매매 시스템이다.

## 개발 방향

```text
시장 데이터
   ↓
전략 엔진
   ↓
위험관리(Risk Manager) + Kill Switch
   ↓
주문 관리(Order Manager)
   ↓
KIS Open API
   ↓
체결/잔고/포지션 대조(reconciliation)
```

실제 매매는 `DRY_RUN → KIS 모의투자(PAPER) → 실계좌(LIVE)` 순서로 단계적으로 검증한다. 실계좌 주문은 구현하지 않았으며, 명시적인 활성화와 위험관리 검증을 모두 통과하기 전에는 추가하지 않는다.

## 현재 상태

현재 단계와 남은 작업은 [`docs/status.md`](./docs/status.md)를 기준으로 한다.

- Cloudflare Worker `quote-api`: KIS 인증/토큰 캐시, 시세·일봉·계좌·주문내역 조회, reconciliation, DRY_RUN 시뮬레이터, Risk Manager, Kill Switch, PAPER 주문/취소/재동기화, SMA 전략·백테스트, Cron 자동매매 엔진(DRY_RUN/PAPER), 감사 로그·알림, 실계좌 게이트(기본 비활성)
- GitHub Pages 프론트엔드: 상태 스트립·요약 타일, 관심종목 시세, 계좌 현황, DRY_RUN 주문(사유 기록), 자동매매 시작/정지/1회 실행, Kill Switch, 이력 탭(DRY_RUN 주문·자동매매 실행 사유·감사 로그·KIS 주문), 60초 자동 새로고침
- 운영 Worker의 `KIS_ENVIRONMENT`는 `LIVE`(조회 전용)이므로 PAPER 주문 전송은 운영 환경에서 수행하지 않는다. 실계좌 주문은 `docs/operations.md` §8 절차 없이는 열리지 않는다

## 구조

```text
GitHub Pages (src/)  ──HTTPS──▶  Cloudflare Worker (workers/quote-api/)  ──▶  KIS Open API
                                   ├─ Durable Object: 내부 주문/포지션 상태
                                   ├─ Durable Object: DRY_RUN 가상 계좌
                                   ├─ Durable Object: Kill Switch
                                   └─ Durable Object + KV: KIS Access Token
```

## 개발

```bash
# 프론트엔드
npm install
npm run dev          # 개발 서버 (VITE_QUOTE_API_BASE_URL 없으면 샘플 시세 모드)
npm run check        # 타입체크
npm test             # src/ 테스트
npm run build

# Worker
cd workers/quote-api
npm install
npm run check        # 타입체크 (@cloudflare/workers-types)
npm test             # vitest, KIS 실호출 없음
cp .dev.vars.example .dev.vars   # APP_KEY 등 로컬 Secret 입력 (gitignore됨)
npm run dev          # http://localhost:8787, ALLOWED_ORIGIN=http://localhost:5173
npm run dev:paper    # 모의투자 키로 KIS_ENVIRONMENT=PAPER 실행
```

프론트에서 로컬 Worker를 쓰려면 루트에 `.env.local`을 만들고 `VITE_QUOTE_API_BASE_URL=http://localhost:8787`을 넣은 뒤 `npm run dev`를 실행한다. 배포된 Worker는 `ALLOWED_ORIGIN`이 GitHub Pages 도메인으로 고정되어 `localhost`에서 직접 호출할 수 없다. 로컬 Worker의 KV/Durable Object는 `.wrangler/state/`에 저장되며 운영 상태와 분리된다.

배포는 GitHub Actions가 수행한다. `deploy-worker.yml`은 check → test → wrangler deploy, `deploy-pages.yml`은 test → build → Pages 배포 순서다.

## 문서

- [`agent.md`](./agent.md) — 프로젝트 목표, 자동매매 안전 원칙, 작업 절차
- [`CLAUDE.md`](./CLAUDE.md) — 검증 명령, 모듈 구조, 코드 작성 규칙
- [`docs/status.md`](./docs/status.md) — 현재 구현 상태, 최근 변경, 남은 작업
- [`docs/roadmap.md`](./docs/roadmap.md) — 단계별 개발 로드맵
- [`docs/design.md`](./docs/design.md) — 시스템 구조, Worker 엔드포인트 계약, 데이터 모델
- [`docs/trading.md`](./docs/trading.md) — 전략·주문·Risk 규칙
- [`docs/operations.md`](./docs/operations.md) — 운영 매뉴얼, 장애 대응, 실계좌 활성화 체크리스트
- [`docs/quote-contract.md`](./docs/quote-contract.md) — 시세 API 계약 및 freshness 정책
- [`docs/api-strategy.md`](./docs/api-strategy.md) — 데이터 공급자 선정 기록

## 보안

KIS App Key, App Secret, Access Token, 계좌번호 등 민감정보는 소스 코드와 GitHub 저장소에 저장하지 않는다. GitHub Actions Secrets → Cloudflare Worker Secret으로만 주입하며 브라우저에 노출하지 않는다.

브라우저는 공개된 Worker URL만 사용하며 KIS 인증정보를 직접 보유하거나 KIS 주문 API를 호출하지 않는다.
