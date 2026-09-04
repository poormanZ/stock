# Stock Dashboard 설계 문서

## 1. 목적
여러 주식 종목의 핵심 시세 정보를 하나의 웹 화면에서 동시에 확인하고 비교할 수 있는 대시보드를 만든다.

## 2. MVP 목표
첫 번째 완성 가능한 버전에서는 다음 흐름을 제공한다.

1. 대시보드 접속
2. 기본 관심종목 목록 표시
3. 여러 종목의 현재가/등락/등락률/거래량을 카드 또는 테이블로 동시 확인
4. 종목 추가 및 삭제
5. 새로고침으로 데이터 갱신
6. 데이터 기준 시각과 데이터 제공 상태 표시
7. GitHub Pages에서 실제 서비스 화면 확인

실제 주문, 계좌 연결, 투자자산 관리, 알림은 MVP 이후 범위다.

## 3. 화면 구성

### Header
- 서비스명
- 마지막 데이터 갱신 시각
- 전체 새로고침 버튼

### Watchlist 영역
- 관심종목 검색/추가 입력
- 관심종목 목록
- 종목별 삭제 기능
- 현재 Phase 2에서는 샘플 카탈로그를 검색 대상으로 사용

### Stock Dashboard
각 종목은 동일한 구조의 카드로 표시한다.
- 종목명
- 티커
- 현재가
- 전일 대비 금액
- 전일 대비 등락률
- 거래량
- 시장 상태
- 데이터 시각/지연 표시
- 관심종목 삭제 버튼

화면 폭에 따라 카드가 자동으로 재배치되도록 반응형 그리드를 사용한다.

## 4. 데이터 모델
초기 공통 모델은 다음 개념을 기준으로 한다.

```text
StockQuote
- symbol
- name
- market
- price
- change
- changePercent
- volume
- marketStatus
- asOf
- source
- delayed
```

데이터 공급자별 응답 형식은 이 모델로 변환한 후 UI에 전달한다. 이를 통해 향후 데이터 공급자를 교체할 수 있도록 한다.

## 5. 상태 관리
필수 상태:
- `watchlist`: 현재 관심종목 배열
- `quotes`: 종목별 시세 데이터
- `loading`: 데이터 조회 상태
- `error`: 조회 실패 상태
- `lastUpdated`: 마지막 성공 갱신 시각

초기에는 별도의 상태관리 라이브러리 없이 프론트엔드 기본 상태 기능으로 시작한다.

## 6. 저장 정책
로그인 없이 사용할 수 있도록 초기에는 브라우저 로컬 저장소를 사용한다.
- 관심종목 목록 저장
- 사용자가 삭제/추가하면 즉시 저장
- 저장 데이터가 없으면 기본 종목 세트를 제공
- 저장값에는 시세 객체가 아니라 종목 코드만 저장하여 향후 실제 데이터 공급자 교체 시에도 사용할 수 있도록 한다.

## 7. 데이터 연동 전략
MVP 개발 순서는 `샘플 데이터 → 실제 API 추상화 → 실제 데이터 연결`로 한다.

### QuoteProvider
UI는 특정 API에 직접 의존하지 않는다.

```text
UI
 ↓
QuoteProvider
 ↓
SampleQuoteProvider / HttpQuoteProvider
 ↓
StockQuote[]
```

`SampleQuoteProvider`는 샘플 카탈로그를 동일한 `QuoteProvider` 계약으로 제공한다. 실제 모드에서는 `HttpQuoteProvider`가 서버리스 `/quotes` 엔드포인트를 통해 여러 종목을 한 번에 조회한다.

### 실제 API 연결 전 확인 항목
- 정적 GitHub Pages에서 직접 호출 가능한지
- CORS 지원 여부
- API 키가 필요한지
- 브라우저에 비밀값이 노출되지 않는 구조인지
- 무료/유료 요금 및 호출 제한
- 실시간/지연 시세 제공 범위
- 국내 시장 및 종목 코드 지원 여부
- 데이터 사용 약관 및 재배포 조건

### 서버리스 Proxy
GitHub Pages는 정적 호스팅이므로 KIS Appsecret은 브라우저에 배포하지 않는다. Cloudflare Worker가 KIS 인증과 현재가 조회를 담당하고, 프론트엔드는 필요한 시세 데이터만 받는다.

현재 Worker는 다음 엔드포인트를 제공한다.
- `GET /quote?symbol=005930`: 단일 종목 호환 API
- `GET /quotes?symbols=005930,000660,...`: 최대 20종목 일괄 조회
- KIS Access Token은 Worker 실행 인스턴스에서 캐시하고 동시 토큰 발급 요청을 합친다.
- KIS 인증정보는 Worker Secret으로만 주입한다.

## 8. 배포
GitHub Actions에서 다음 파이프라인을 기본으로 한다.

```text
push main
  ↓
install dependencies
  ↓
build
  ↓
GitHub Pages deploy
```

빌드 실패 시 배포하지 않는다.

실제 시세 서비스는 별도의 Cloudflare Worker 배포가 필요하다.

## 9. 폴더 구조

```text
/
├─ .github/workflows/
├─ docs/
├─ workers/
│  └─ quote-api/
│     ├─ src/index.ts
│     └─ wrangler.toml
├─ src/
│  ├─ components/
│  ├─ data/
│  ├─ services/
│  │  ├─ quoteProvider.ts
│  │  ├─ sampleQuoteProvider.ts
│  │  └─ httpQuoteProvider.ts
│  ├─ types/
│  └─ styles/
├─ agent.md
├─ index.html
├─ package.json
├─ tsconfig.json
└─ vite.config.ts
```

## 10. 단계별 구현 계획

### Phase 0 — 기반
- [x] agent.md
- [x] 설계 문서
- [x] Vite + TypeScript 확정
- [x] GitHub Actions/Pages 배포 워크플로 구성
- [x] 최소 웹 진입점 구성
- [ ] GitHub Pages 실제 배포 성공 확인

### Phase 1 — 정적 대시보드
- [x] 기본 레이아웃
- [x] 반응형 카드
- [x] 6개 샘플 주가 데이터
- [x] 상승/하락/보합 시각 구분
- [x] 데이터 시각/지연 상태 표시
- [x] 새로고침 인터랙션
- [x] 모바일 1열 / 태블릿 2열 / 데스크톱 3열 대응
- [ ] 별도 로딩/오류 상태 컴포넌트

### Phase 2 — 관심종목
- [x] 종목 검색/추가
- [x] 삭제
- [x] localStorage 저장
- [x] 저장값이 없을 때 기본 6개 종목 복원
- [x] 잘못된 검색/중복 추가 피드백
- [x] 카드별 삭제 버튼

### Phase 3 — 실제 데이터 기반
- [x] QuoteProvider 인터페이스
- [x] SampleQuoteProvider 구현
- [x] 새로고침을 Provider 호출 흐름으로 전환
- [x] 로딩 상태 표시
- [x] Provider 오류 상태 표시
- [x] 실제 API 어댑터
- [x] 서버리스 KIS Proxy 초안
- [x] 다중 종목 일괄 조회 및 Access Token 캐시
- [ ] KIS 계정/앱키 발급 및 Worker Secret 설정
- [ ] Cloudflare Worker 실제 배포
- [ ] GitHub Pages에서 Worker 연결 설정
- [ ] 실제 API 엔드포인트 통합 검증
- [ ] 실제 API의 지연/오류 정책 확정

### Phase 4 — 차트/분석
- 종목별 가격 차트
- 기간 선택
- 정렬/필터

### Phase 5 — 품질 개선
- 모바일 대응
- 접근성
- 성능 최적화
- 테스트
- 배포 자동화 안정화

## 11. 초기 기술 선택
**Vite + TypeScript**를 선택한다.

선정 이유:
- GitHub Pages 같은 정적 호스팅에 적합
- 개발 서버와 프로덕션 빌드가 단순함
- TypeScript로 주식 데이터 모델을 명확하게 유지할 수 있음
- 별도 UI 프레임워크 없이도 작은 MVP를 빠르게 시작할 수 있음
- 이후 필요하면 컴포넌트 계층을 확장할 수 있음

초기에는 React 같은 추가 UI 프레임워크를 도입하지 않고 Vite + TypeScript + HTML/CSS로 시작해 의존성을 최소화한다.

## 12. MVP 완료 조건
- 최소 5개 이상의 종목을 한 화면에서 동시에 볼 수 있다.
- 관심종목 추가/삭제가 동작한다.
- 새로고침이 동작한다.
- 데이터 시각/상태가 표시된다.
- 모바일/데스크톱에서 레이아웃이 깨지지 않는다.
- GitHub Actions 빌드가 성공한다.
- GitHub Pages에서 실제 화면을 확인할 수 있다.
