# 한국투자증권 자동 주식매매 시스템 설계 문서

> 기준일: 2026-09-15 (미커밋 작업 포함)

## 1. 목적

`poormanZ/stock`은 한국투자증권(KIS) Open API를 이용해 국내 주식 시세를 조회하고, 전략·위험관리·주문·체결·포지션까지 확장할 수 있는 웹 기반 자동매매 시스템을 구축한다.

핵심 흐름은 다음과 같다.

```text
시장 데이터
   ↓
전략 엔진 (미구현)
   ↓
주문 후보
   ↓
Kill Switch / Risk Manager ── 차단 ──→ 종료
   ↓ 승인
Order Manager (라우트 + Order 상태 머신)
   ↓
KIS API (PAPER) 또는 DRY_RUN 시뮬레이터
   ↓
주문/체결 상태
   ↓
내부 상태 저장 (Durable Object) ↔ KIS reconciliation
```

**DRY_RUN → PAPER → LIVE** 순서로 확장하며, 브라우저가 자동매매의 실행 주체가 되지 않도록 한다.

## 2. 배포 구조

```text
GitHub Pages / Browser (src/)
        │ HTTPS (CORS: ALLOWED_ORIGIN)
        ▼
Cloudflare Worker  stock-quote-api  (workers/quote-api/)
        │
        ├─ KV  KIS_TOKEN_CACHE          KIS Access Token 캐시
        ├─ DO  KISTokenBroker           isolate 간 토큰 발급 단일화
        ├─ DO  InternalStateStoreDO     내부 주문 기록(orderRecords)·요약 주문·포지션
        ├─ DO  DryRunStateStoreDO       DRY_RUN 가상 현금/포지션/주문
        └─ DO  RiskStateStoreDO         Kill Switch 상태
        │
        ▼
KIS Open API  (KIS_ENVIRONMENT: LIVE → openapi, PAPER → openapivts)
```

- 운영 Worker의 `KIS_ENVIRONMENT`는 `LIVE`다. LIVE에서는 조회만 수행하고 주문 API는 구현하지 않는다.
- PAPER 주문 경로(`/paper/*`)는 `KIS_ENVIRONMENT=PAPER`일 때만 동작한다.
- Secret(`APP_KEY`, `APP_SECRET`, `ACCOUNT_CANO`, `ACCOUNT_PRODUCT_CODE`)은 GitHub Actions Secrets → wrangler secret으로 주입한다.

## 3. Worker 모듈 배치

```text
workers/quote-api/src/
  worker.ts                  wrangler 진입점. 라우터와 DO 클래스 re-export
  index.ts                   "METHOD /path" → 핸들러 디스패치, OPTIONS 204, 404/405, 예외 → 500(JSON+CORS)
  query-routes.ts            /quote /quotes /account /account/assets /buyable /orders /reconciliation
  dry-run-routes.ts          /dry-run /dry-run/orders /dry-run/reset
  paper-routes.ts            /paper/orders /paper/orders/cancel /paper/reconcile
  risk-routes.ts             /risk /risk/kill-switch
  env.ts                     Env 타입, getEnvironment, create*Adapter 팩토리, getPrimaryStore
  http.ts                    json / noContent / withCors / errorResponse(scope)
  state-clients.ts           DO 호출 래퍼 (readInternalState, applyInternalOrder, readKillSwitch, …)
  kis-common.ts              KISEnvironment, base URL, toNumber, validateAccountParts, assertAccepted,
                             forEachKisPage(연속조회), KST 날짜, kisTimestampToIso
  kis-token.ts               토큰 레코드 스키마, 만료 계산(KST, 5분 마진), requestKisToken
  kis-http-client.ts         Bearer 헤더, 토큰 캐시(메모리→KV→브로커→직접 발급), 요청 간격, 재시도
  kis-token-broker.ts        KISTokenBroker DO
  kis-quote-adapter.ts       주식현재가 → StockQuote
  kis-account-adapter.ts     잔고/계좌자산/매수가능 → AccountSnapshot, BuyableOrder
  kis-order-adapter.ts       일별 주문체결 → OrderRecord[]
  kis-paper-order-adapter.ts PAPER 현금주문/취소 (VTTC0012U / VTTC0011U / VTTC0013U)
  kis-reconciliation.ts      KIS 계좌·당일 주문 ↔ 내부 상태 대조
  reconciliation.ts          순수 대조 로직
  paper-order-reconciliation.ts  브로커 주문 상태를 내부 Order에 resync
  order-domain.ts            Order / CreateOrderRequest, 상태 머신, createOrder, transitionOrder
  order-gate.ts              reconciliation 기반 신규주문 Gate
  risk-manager.ts            checkRisk, DEFAULT_RISK_CONFIG, RiskStateStoreDO
  dry-run-simulator.ts       simulateOrder, DryRunStateStoreDO
  internal-state-store.ts    InternalStateStoreDO
  market-session.ts          KST 정규장(09:00~15:30, 평일) 판정. 휴장일 미반영
  position-ledger.ts         체결 증분 → 포지션·평균단가·당일 실현손익 (순수)
  daily-loss.ts              KIS 기간별매매손익(LIVE) 집계 (순수)
  strategy.ts                Strategy 인터페이스, SMA 교차 전략, 손절/익절, 포지션 사이징 (순수)
  backtest.ts                일봉 백테스트 (DRY_RUN 비용 모델 공유)
  kis-candle-adapter.ts      일봉(FHKST03010100) → Candle[]
  strategy-routes.ts         /candles /strategies /backtest
  trading-state.ts           TradingStateStoreDO (설정·상태·lease·실행 이력)
  trading-engine.ts          Cron 사이클 (TradingDeps 주입)
  trading-routes.ts          /trading/*
  kis-cash-order-adapter.ts  현금주문 공통 (PAPER/LIVE TR 매핑). paper/live 어댑터의 부모
  live-trading-gate.ts       실계좌 게이트 (순수)
  live-routes.ts             /live/*
  audit-log.ts / audit-routes.ts  AuditLogStoreDO, /audit
  alerts.ts                  ALERT_WEBHOOK_URL 알림
  quote-contract.ts          종목코드/개수 검증
  kis-security.ts            민감정보 마스킹
```

계층 원칙:

- 라우트는 KIS 응답 필드명을 직접 다루지 않는다. 어댑터가 내부 모델로 변환한다.
- 어댑터는 KIS 통신만 담당하고 상태를 저장하지 않는다.
- 주문 상태 변경은 `transitionOrder`만 사용한다.
- Risk Manager(`checkRisk`)와 Kill Switch는 DRY_RUN·PAPER 모든 주문 경로가 통과한다.

## 4. Worker 엔드포인트

| 메서드 | 경로 | 조건 | 응답 |
|---|---|---|---|
| GET | `/quote?symbol=` / `/quotes?symbols=` | 6자리 종목코드, 최대 20개 | `StockQuote` / `StockQuote[]` ([계약](./quote-contract.md)) |
| GET | `/account` | 계좌 설정 | `AccountSnapshot` |
| GET | `/account/assets` | 계좌 설정 | KIS 계좌자산 원문(`output1`, `output2`) |
| GET | `/buyable?symbol=&price=&orderType=` | 계좌 설정 | `BuyableOrder` |
| GET | `/orders?startDate=&endDate=` | 계좌 설정, `YYYYMMDD`, 기본 당일 | `OrderHistorySnapshot` |
| GET | `/reconciliation` | 계좌 설정 | `{ asOf, environment, status, canPlaceNewOrders, differences[] }` |
| GET | `/risk` | — | `KillSwitchState` |
| POST | `/risk/kill-switch` | `{ action: 'activate' \| 'deactivate', reason? }` | `KillSwitchState` |
| GET | `/dry-run` | — | `DryRunState` |
| POST | `/dry-run/orders` | `{ request, referencePrice, fillQuantity?, config? }` | `{ mode: 'DRY_RUN', order, cash, positions, … }`. 동일 `clientOrderId`는 `idempotent: true` |
| POST | `/dry-run/reset` | `{ initialCash? }` | `DryRunState` |
| POST | `/paper/orders` | PAPER 환경, 계좌 설정, 정규장 | `{ order, messageCode, message }` / 멱등 `{ idempotent: true, order }` |
| POST | `/paper/orders/cancel` | PAPER 환경, 계좌 설정, 정규장, `{ id \| clientOrderId }` | `{ order, messageCode, message }` |
| POST | `/paper/reconcile` | PAPER 환경, 계좌 설정 (장외 허용) | `{ account, updated, unresolved[], orders[] }` |
| POST | `/paper/position-sync` | PAPER 환경, 계좌 설정 (장외 허용) | KIS 포지션(평균단가 포함)을 내부 기준선으로 채택 |
| GET | `/candles?symbol=&startDate=&endDate=` | 최대 1,000일 | `{ candles: Candle[] }` (일봉, 오래된 순) |
| GET | `/strategies` | — | `{ strategies: string[] }` |
| POST | `/backtest` | `{ symbol, startDate?, endDate?, strategy, initialCash?, exit?, sizing? }` | 지표·거래·자산곡선. `disclaimer` 포함 |
| GET | `/trading/status` / `/trading/runs?limit=` | — | `TradingState` / 실행 이력 |
| POST | `/trading/configure` / `/trading/start` / `/trading/stop` / `/trading/run` | `config`(mode DRY_RUN\|PAPER, symbols≤10, strategy, exit, sizing, candleBars) | `TradingState` / 사이클 결과 |
| GET | `/audit?limit=&type=` | — | `{ count, events[] }` (최신순) |
| GET | `/live/status` | — | 게이트 `checks`와 `reason` |
| POST | `/live/arm` / `/live/disarm` | `LIVE_TRADING_ENABLED='true'`, `{ confirmation, ttlSeconds≤900, reason }` | 실계좌 arm 상태 |
| POST | `/live/orders` / `/live/orders/cancel` | 게이트 전부 통과 + `confirmation` | PAPER와 동일 계약(`LIVE_*` 코드) |

공통 규칙:

- 모든 응답은 `ALLOWED_ORIGIN` 기준 CORS 헤더와 `cache-control: no-store`를 가진다. `OPTIONS`는 body 없는 204다.
- 알 수 없는 경로는 404 `NOT_FOUND`, 아는 경로의 미지원 메서드는 405 `METHOD_NOT_ALLOWED`, 처리되지 않은 예외는 500 `INTERNAL_ERROR`.
- 오류 본문은 `{ error: CODE, message?, code?(KIS msg_cd), status?(KIS HTTP) }`. KIS 원문 오류에는 인증정보가 포함되지 않도록 마스킹한다.

주요 오류 코드:

| 코드 | HTTP | 의미 |
|---|---|---|
| `KIS_AUTH_FAILED` / `KIS_RATE_LIMITED` / `KIS_TIMEOUT` / `KIS_UPSTREAM_ERROR` / `KIS_INVALID_RESPONSE` | 502 / 429 / 504 / 502 / 502 | KIS HTTP 계층 오류 |
| `KIS_ACCOUNT_REJECTED`, `KIS_ACCOUNT_ASSET_REJECTED`, `KIS_BUYABLE_REJECTED`, `KIS_ORDER_HISTORY_REJECTED` | 502 | KIS가 `rt_cd != '0'`으로 거부 |
| `ACCOUNT_NOT_CONFIGURED` / `ACCOUNT_CONFIG_INVALID` | 503 | 계좌 Secret 누락 / 형식 오류 |
| `*_UNAVAILABLE` | 502/503 | 해당 범위의 기타 실패. 내부 상태 DO 실패는 503 |
| `INVALID_ORDER`, `INVALID_REFERENCE_PRICE`, `INVALID_*_REQUEST` | 400 | 요청 검증 실패 |
| `KILL_SWITCH_ACTIVE`, `MAX_*`, `STALE_QUOTE`, `RECONCILIATION_MISMATCH` 등 `RiskReason` | 409 | Risk Manager / Gate 차단. 본문에 `risk` 포함 |
| `PAPER_ENVIRONMENT_REQUIRED`, `MARKET_SESSION_CLOSED` | 409 | PAPER 선행 조건 미충족 |
| `LIVE_TRADING_DISABLED` | 403 | 실계좌 게이트 기본 비활성. KIS 호출 없음 |
| `PAPER_VERIFICATION_REQUIRED`, `LIVE_TRADING_NOT_ARMED`, `LIVE_CONFIRMATION_REQUIRED` 등 `LiveGateReason` | 409 | 실계좌 게이트 차단. 본문에 `gate.checks` |
| `DAILY_LOSS_UNAVAILABLE` | 409 | 당일 손익 공급원 없음 (fail-closed) |
| `TRADING_NOT_CONFIGURED`, `TRADING_RUNNING`, `EMERGENCY_STOP_ACTIVE`, `INVALID_TRADING_CONFIG` | 409/400 | 자동매매 제어 |
| `PAPER_ORDER_REJECTED`, `PAPER_ORDER_CANCEL_REJECTED`, `ORDER_NOT_CANCELLABLE` | 409 | 브로커 거부 / 취소 불가 상태 |
| `PAPER_ORDER_UNKNOWN`, `PAPER_ORDER_CANCEL_UNKNOWN` | 502 | 전송 결과 불확실. 내부 상태는 `UNKNOWN` |
| `ORDER_NOT_FOUND` | 404 | 취소 대상 없음 |

## 5. 실행 모드

| 모드 | KIS 외부 주문 | 장 운영시간 의존 | 사용 검사 |
|---|---:|---:|---|
| DRY_RUN | 없음 | 없음 | 요청 검증, Kill Switch, Risk Manager(`referencePrice`, 현재 시각을 시세 기준 시각으로 사용) |
| PAPER | 모의투자 | 정규장만 | 위 항목 + 계좌 설정, reconciliation Gate, 실시간 시세(`fetchedAt` 기준 15초), `clientOrderId` 멱등성 |
| LIVE | 실계좌 (기본 비활성) | 정규장만 | 위 PAPER 항목 + `checkLiveTradingGate`(플래그, PAPER 검증일, arm, 확인 문구). 운영자 수동 호출만, 스케줄러 미지원 |
| 자동매매 엔진 | DRY_RUN 또는 PAPER | PAPER만 정규장 | RUNNING 상태에서 Cron 5분 사이클. Kill Switch → EMERGENCY_STOP, 오류 → ERROR |

DRY_RUN은 장외시간·주말에도 KIS 상태와 무관하게 동작해야 하며, 이를 위해 PAPER/LIVE 안전장치를 약화하지 않는다.

## 6. 데이터 모델 (코드 기준)

```text
StockQuote          symbol, price, change, changePercent, volume, asOf(KIS 체결시각 또는 ""),
                    fetchedAt(수신 ISO), market: 'KRX', source, delayed
AccountSnapshot     asOf, environment, source, cash, settlementD1Cash, settlementD2Cash,
                    totalEquity, netAssetValue, positions: AccountPosition[]
AccountPosition     symbol, name, quantity, averagePrice, currentPrice, purchaseAmount,
                    evaluationAmount, profitLossAmount, profitLossPercent
CreateOrderRequest  id, clientOrderId, symbol, side('buy'|'sell'), orderType('market'|'limit'),
                    quantity(정수 > 0), limitPrice?(limit일 때 필수, market일 때 금지),
                    reason?(≤200자. 전략 신호/손절/익절/manual. KIS로 전송하지 않고 내부 기록·감사 로그에만 남김)
Order               CreateOrderRequest + brokerOrderId?, brokerOrderOrgNo?, executedQuantity,
                    averageExecutedPrice, status, createdAt, updatedAt
OrderRecord (KIS)   brokerOrderId, originalOrderId, orderDate, symbol, name, side, orderType,
                    quantity, orderPrice, executedQuantity, averageExecutedPrice, status, orderTime
InternalState       positions[], orders[](brokerOrderId 요약), orderRecords[](Order 전체), updatedAt
DryRunState         cash, positions[{symbol, quantity, averagePrice}], orders: Order[], updatedAt
KillSwitchState     active, reason?, activatedAt?, updatedAt
```

계좌번호 전체를 UI나 일반 로그에 노출하지 않는다.

## 7. 주문 상태 머신

```text
CREATED → SUBMITTING → SUBMITTED → ACCEPTED → PARTIALLY_FILLED → FILLED
```

허용 전이(`order-domain.ts`):

| from | to |
|---|---|
| CREATED | SUBMITTING, CANCELED |
| SUBMITTING | SUBMITTED, REJECTED, UNKNOWN |
| SUBMITTED | ACCEPTED, PARTIALLY_FILLED, FILLED, CANCEL_PENDING, CANCELED, REJECTED, UNKNOWN |
| ACCEPTED | PARTIALLY_FILLED, FILLED, CANCEL_PENDING, CANCELED, REJECTED, UNKNOWN |
| PARTIALLY_FILLED | PARTIALLY_FILLED, FILLED, CANCEL_PENDING, CANCELED, UNKNOWN |
| CANCEL_PENDING | PARTIALLY_FILLED, FILLED, CANCELED, UNKNOWN |
| UNKNOWN | RECONCILING |
| RECONCILING | SUBMITTED, ACCEPTED, PARTIALLY_FILLED, FILLED, CANCEL_PENDING, CANCELED, REJECTED, UNKNOWN |
| FILLED / CANCELED / REJECTED | (종결) |

- `FILLED`는 `executedQuantity === quantity`, `PARTIALLY_FILLED`는 `0 < executedQuantity < quantity`를 요구한다.
- 전송 중 네트워크/타임아웃/응답 파싱 실패는 `UNKNOWN`으로 기록하고 재전송하지 않는다. `/paper/reconcile`이 KIS 당일 주문내역으로 `UNKNOWN → RECONCILING → 실제 상태`로 복구한다.
- 주문 POST는 KIS 5xx 응답에 재시도하지 않는다(중복 주문 위험). 429만 재시도한다.
- 취소 접수 응답은 `CANCEL_PENDING`으로 기록한다. 취소 전 체결과의 경합은 resync가 KIS 내역으로 확정한다.

## 8. 중복 주문 방지

- 모든 주문은 클라이언트가 생성한 `id`와 `clientOrderId`를 가진다. DRY_RUN은 `DRY-` 접두어를 쓰며 PAPER 어댑터는 이를 거부한다.
- PAPER: `orderRecords`에 같은 `clientOrderId`가 있으면 KIS를 호출하지 않고 기존 주문을 반환한다.
- DRY_RUN: 라우트와 DO 양쪽에서 같은 `clientOrderId`를 멱등 처리한다.
- 재시작 시 메모리 상태를 신뢰하지 않는다. 내부 상태는 DO에 저장되며 `/paper/reconcile`과 `/reconciliation`으로 KIS와 대조한다.

## 9. 인증 및 토큰

- 토큰 조회 순서: isolate 메모리 → KV(`kis-access-token:<baseUrl>`, `{ accessToken, expiresAt }`) → `KISTokenBroker` DO → 직접 발급(브로커 미설정 시).
- KIS 만료시각은 KST 문자열이므로 `+09:00`으로 해석하고 5분 안전 마진을 뺀다.
- API가 401/403 또는 `EGW00121`/`EGW00123`을 돌려주면 캐시를 무효화하고 1회만 재발급 후 재시도한다.
- 로그·오류 메시지에는 `redactSensitiveText`를 적용한다. `APP_KEY`, `APP_SECRET`, 토큰, 전체 계좌번호를 남기지 않는다.

## 10. 데이터 신뢰성

- `StockQuote.fetchedAt`은 항상 존재한다. `asOf`는 KIS 현재가 API가 체결시각을 주지 않아 운영에서 비어 있다.
- Risk Manager의 stale 검사는 `kisTimestampToIso(asOf) ?? fetchedAt` 기준 15초(`maxQuoteAgeMs`)다.
- 가격이 없거나 0 이하이면 시세 오류로 처리한다. 오래된 시세를 최신처럼 표시하지 않는다.
- 다음 상태에서는 신규 주문을 차단한다: Kill Switch, reconciliation 불일치(PAPER), API 장애, 유효하지 않은 기준가, stale 시세, 수량/금액/포지션/일일 한도 초과.

## 11. 알려진 한계

- 내부 포지션 기준선은 `POST /paper/position-sync`로 운영자가 만든다. 기준선 이전 손익은 PAPER 실현손익에 반영되지 않는다.
- `TTTC8715R` 기간별매매손익은 LIVE 전용이라 PAPER는 내부 원장으로 대체한다.
- `market-session.ts`는 KRX 휴장일을 반영하지 않는다. 휴장일 사이클은 KIS 응답에 따라 `ERROR`로 전이할 수 있다.
- 자동매매는 하루에 종목·방향별 1회만 주문한다(멱등 키 `AUTO-{mode}-{날짜}-{종목}-{방향}`).
- Risk 한도·전략 파라미터 기본값은 코드 상수다. 감사 로그는 500건만 유지한다.
- 스케줄러는 LIVE 모드를 지원하지 않는다. 실계좌 주문은 운영자의 수동 호출만 가능하다.

## 12. 프론트엔드

```text
src/
  main.ts            진입점. 상태 갱신·제어 동작·렌더·이벤트 위임(data-action / data-field)
  state.ts           AppState, 선호(자동 새로고침·이력 탭) localStorage 저장
  api/client.ts      WorkerApi (Worker 호출 래퍼, WorkerApiError)
  api/types.ts       Worker 응답 타입 (Worker 실제 필드명과 일치)
  format.ts          금액/수량/시간 포맷, 상태 한글 라벨, 색 톤, 신호 사유 설명(describeReason)
  views/*.ts         header(상태 스트립) / summary(요약 타일) / market / orderPanel / tradingPanel / account / history(탭)
  services/          시세 Provider(HTTP·샘플), 신선도 판정(asOf 없으면 fetchedAt 기준)
```

- 화면 구성: 상단 상태 스트립(API·엔진·Kill Switch·동기화 시각·자동 새로고침) → 요약 타일 6개 → 관심종목 → 주문 시뮬레이터 + 자동매매 엔진 → 계좌 현황 → 이력 탭(DRY_RUN 주문 / 자동매매 실행 / 감사 로그 / KIS 당일 주문).
- 이력의 DRY_RUN 주문에는 `reason`을, 자동매매 실행에는 종목별 신호·주문 결과·사유를 한글 설명으로 표시한다(예: `SMA5>SMA20` → "5일선이 20일선을 상향 돌파", `STOP_LOSS:-5.20%` → "손절 (평균단가 대비 -5.20%)").
- 60초 자동 새로고침(탭이 보일 때만). 렌더는 전체 다시 그리기 방식이며 리스너는 루트에 한 번만 붙인다.
- `VITE_QUOTE_API_BASE_URL`이 없으면 샘플 시세 모드.
- 사용하는 Worker 엔드포인트: `/quotes`, `/account`, `/dry-run`, `/orders`, `/reconciliation`, `/risk`, `/trading/status`, `/audit?limit=40`, `/dry-run/orders`, `/dry-run/reset`, `/trading/start|stop|run`, `/risk/kill-switch`.
- DRY_RUN 주문 버튼은 Kill Switch와 시세 유효성에만 의존한다. reconciliation 결과는 정보용 배지로 표시한다.
- 자동매매 패널은 DRY_RUN 모드(관심종목, SMA 5/20)만 시작할 수 있다. PAPER/LIVE는 UI에서 시작하지 않는다.
- 브라우저는 KIS Secret을 보유하지 않으며 KIS 주문 API를 직접 호출하지 않는다.
