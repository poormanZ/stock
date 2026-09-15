# 한국투자증권 자동 주식매매 시스템 설계 문서

> 기준일: 2026-09-15

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
| `PAPER_ORDER_REJECTED`, `PAPER_ORDER_CANCEL_REJECTED`, `ORDER_NOT_CANCELLABLE` | 409 | 브로커 거부 / 취소 불가 상태 |
| `PAPER_ORDER_UNKNOWN`, `PAPER_ORDER_CANCEL_UNKNOWN` | 502 | 전송 결과 불확실. 내부 상태는 `UNKNOWN` |
| `ORDER_NOT_FOUND` | 404 | 취소 대상 없음 |

## 5. 실행 모드

| 모드 | KIS 외부 주문 | 장 운영시간 의존 | 사용 검사 |
|---|---:|---:|---|
| DRY_RUN | 없음 | 없음 | 요청 검증, Kill Switch, Risk Manager(`referencePrice`, 현재 시각을 시세 기준 시각으로 사용) |
| PAPER | 모의투자 | 정규장만 | 위 항목 + 계좌 설정, reconciliation Gate, 실시간 시세(`fetchedAt` 기준 15초), `clientOrderId` 멱등성 |
| LIVE | 미구현 | — | 조회만. 주문 API 추가 시 별도 명시적 활성화 게이트 필요 |

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
                    quantity(정수 > 0), limitPrice?(limit일 때 필수, market일 때 금지)
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
| SUBMITTED | ACCEPTED, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, UNKNOWN |
| ACCEPTED | PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, UNKNOWN |
| PARTIALLY_FILLED | PARTIALLY_FILLED, FILLED, CANCELED, UNKNOWN |
| UNKNOWN | RECONCILING |
| RECONCILING | SUBMITTED, ACCEPTED, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, UNKNOWN |
| FILLED / CANCELED / REJECTED | (종결) |

- `FILLED`는 `executedQuantity === quantity`, `PARTIALLY_FILLED`는 `0 < executedQuantity < quantity`를 요구한다.
- 전송 중 네트워크/타임아웃/응답 파싱 실패는 `UNKNOWN`으로 기록하고 재전송하지 않는다. `/paper/reconcile`이 KIS 당일 주문내역으로 `UNKNOWN → RECONCILING → 실제 상태`로 복구한다.
- 주문 POST는 KIS 5xx 응답에 재시도하지 않는다(중복 주문 위험). 429만 재시도한다.

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

- 내부 포지션(`InternalState.positions`)을 KIS 계좌로 갱신하는 경로가 없다. 계좌에 보유종목이 있으면 `/reconciliation`은 항상 `MISMATCHED`이며 PAPER 신규 주문 Gate가 닫힌다. 포지션 동기화 정책(체결 기반 갱신 vs KIS 스냅샷 채택)을 결정해야 한다.
- `RiskState.dailyLoss`는 어느 경로에서도 계산하지 않아 일일 손실 한도는 실질적으로 동작하지 않는다.
- PAPER 취소 접수 응답만으로 `CANCELED`로 기록한다. 취소 전 체결과의 경합은 다음 `/paper/reconcile`에서 드러나며, `CANCELED`는 종결 상태라 자동 복구되지 않는다.
- `market-session.ts`는 KRX 휴장일을 반영하지 않는다.
- 감사 로그, 자동 실행 스케줄러, 전략 엔진은 미구현이다.

## 12. 프론트엔드

- `src/main.ts` 단일 파일 대시보드. `VITE_QUOTE_API_BASE_URL`이 없으면 샘플 시세 모드.
- 사용하는 Worker 엔드포인트: `/quotes`, `/account`, `/dry-run`, `/orders`, `/reconciliation`, `/risk`, `/dry-run/orders`, `/dry-run/reset`.
- DRY_RUN 주문 버튼은 Kill Switch와 시세 유효성에만 의존한다. reconciliation 결과는 정보용 배지로 표시한다.
- 브라우저는 KIS Secret을 보유하지 않으며 KIS 주문 API를 직접 호출하지 않는다.
