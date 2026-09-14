# 한국투자증권 자동 주식매매 시스템 설계 문서

> 기준일: 2026-09-14

## 1. 목적

`poormanZ/stock`은 한국투자증권(KIS) Open API를 이용해 국내 주식 시세를 조회하고, 이후 전략·위험관리·주문·체결·포지션까지 확장할 수 있는 웹 기반 자동매매 시스템을 구축한다.

핵심 흐름은 다음과 같다.

```text
시장 데이터
   ↓
전략 엔진
   ↓
주문 후보
   ↓
Risk Manager ── 차단 ──→ 종료
   ↓ 승인
Order Manager
   ↓
KIS API
   ↓
주문/체결 상태
   ↓
Position / Account
   ↓
감사 로그·모니터링
```

초기에는 **DRY_RUN → KIS 모의투자 → 실계좌** 순서로 확장하며, 브라우저가 자동매매의 실행 주체가 되지 않도록 한다.

## 2. 현재 기술 구조

현재 저장소는 Vite + TypeScript 프론트엔드와 Cloudflare Worker 기반 `quote-api`를 사용한다.

```text
GitHub Pages / Browser
        │
        │ HTTPS
        ▼
Cloudflare Worker
  quote-api
        │
        ▼
KIS Open API
```

현재 Worker에는 다음 기능이 구현되어 있다.

- `GET /quote?symbol=005930`
- `GET /quotes?symbols=005930,000660`
- KIS Access Token 캐시
- 동시 token 발급 요청 합치기
- 국내주식 현재가 API 호출
- 내부 `StockQuote` 형태로 응답 변환
- `PAPER` / `LIVE` KIS REST 도메인 분리
- 서버 측 Secret `APP_KEY` / `APP_SECRET` 사용

단, 현재 구현은 **시세 조회 단계**이며 자동 주문 시스템으로 완료된 상태가 아니다.

## 3. 계층 구조

### 3.1 Web UI

역할:
- 관심종목/시세 표시
- 계좌 및 포지션 상태 표시
- 전략 실행 상태 표시
- 주문/체결 상태 표시
- 자동매매 시작/정지/긴급정지 제어

금지:
- App Secret 직접 보관
- Access Token 직접 발급
- KIS 주문 API 직접 호출
- 브라우저만 열어둔 상태를 자동매매 실행 조건으로 사용

필수 실행 상태:

```text
STOPPED
READY
RUNNING
ERROR
EMERGENCY_STOP
```

실계좌/모의투자/DRY_RUN 환경도 항상 UI에서 명확하게 구분한다.

### 3.2 Backend / Worker

역할:
- KIS 인증
- 외부 API 호출
- API 오류/timeout/retry 처리
- 내부 도메인 모델로 변환
- 주문 및 계좌 관련 서버 측 제어
- 민감정보 보호

Cloudflare Worker에서 장시간 실행이 필요한 자동매매 루프를 직접 유지할 수 있다고 가정하지 않는다. 자동 실행이 필요할 경우 Scheduled Trigger 등 서버리스 환경에 적합한 실행 모델을 별도로 검증한다.

### 3.3 KIS Adapter

KIS API의 외부 계약을 내부 도메인에서 분리한다.

```text
KISQuoteClient
KISAccountClient
KISOrderClient
KISFillClient
KISTokenClient
```

각 Adapter는 KIS 고유 응답을 내부 모델로 변환한다. 전략 코드는 KIS 응답 필드명을 직접 참조하지 않는다.

### 3.4 Trading Engine

역할:
- 현재 시장/계좌 상태 입력
- 전략 실행
- 매수/매도 신호 생성
- 주문 크기 계산

전략은 `KISOrderClient`를 직접 호출하지 않고 표준 주문 후보만 생성한다.

### 3.5 Risk Manager

모든 실제 주문의 최종 관문이다.

예시 검사:
- 종목별 최대 수량
- 주문금액 한도
- 총 포지션 한도
- 일일 주문 횟수
- 일일 손실 한도
- 시세 stale 여부
- 계좌/포지션 reconciliation 상태
- API 장애 상태
- 장 운영시간
- Kill Switch 상태
- 자동매매 실행 상태

하나라도 실패하면 신규 주문을 차단한다.

### 3.6 Order Manager

주문 생성부터 최종 상태 확정까지 책임진다.

```text
Strategy Signal
    ↓
Risk Check
    ↓
Create Order
    ↓
Submit
    ↓
Query Status
    ↓
Fill / Cancel / Reject
    ↓
Reconcile
```

HTTP 요청이 성공했다고 체결된 것으로 간주하지 않는다.

## 4. 실행 모드

환경 변수 또는 서버 설정으로 실행 모드를 명시한다.

```text
DRY_RUN
PAPER
LIVE
```

### DRY_RUN
- 외부 주문 API 호출 금지
- 가상 현금/포지션 사용
- 전략과 Risk Manager의 전체 흐름 검증

### PAPER
- KIS 모의투자 환경 사용
- 인증/시세/주문/체결 API의 실제 통합 검증
- 현재 Worker의 기본 `KIS_ENVIRONMENT` 값

### LIVE
- 실계좌 사용
- 기본값으로 선택될 수 없음
- 별도 `LIVE_TRADING_ENABLED` 같은 명시적 활성화 조건 필요
- 계좌 환경과 API 환경이 일치하지 않으면 즉시 차단

KIS REST 도메인은 `KIS_ENVIRONMENT`로 선택한다.

```text
PAPER → https://openapivts.koreainvestment.com:29443
LIVE  → https://openapi.koreainvestment.com:9443
```

## 5. 데이터 모델

### StockQuote

```text
StockQuote
- symbol
- name?
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

### AccountSnapshot

```text
AccountSnapshot
- accountAlias
- availableCash
- totalEquity
- asOf
- source
```

계좌번호 전체를 UI나 일반 로그에 노출하지 않는다.

### Position

```text
Position
- symbol
- quantity
- averagePrice
- currentPrice
- marketValue
- unrealizedPnl
- asOf
```

### Order

```text
Order
- clientOrderId
- brokerOrderId?
- symbol
- side
- orderType
- quantity
- limitPrice?
- mode
- status
- requestedAt
- submittedAt?
- filledQuantity
- remainingQuantity
- averageFillPrice?
- rejectionReason?
- updatedAt
```

## 6. 주문 상태 머신

```text
CREATED
   ↓
SUBMITTING
   ↓
SUBMITTED
   ↓
ACCEPTED
   ↓
PARTIALLY_FILLED
   ↓
FILLED
```

예외 흐름:

```text
SUBMITTED / ACCEPTED → CANCELED
SUBMITTING / SUBMITTED → REJECTED
외부 통신 불확실 → UNKNOWN
UNKNOWN → RECONCILING → 실제 상태 확정
```

`UNKNOWN` 상태에서는 동일 주문을 무조건 재전송하지 않는다. 먼저 KIS 주문 조회로 실제 상태를 확인한다.

## 7. 중복 주문 방지

전략 실행 한 번마다 내부 실행 ID를 생성하고 주문에는 `clientOrderId` 등 내부 추적 ID를 부여한다.

같은 실행에서 동일 종목·방향·조건의 주문이 이미 제출되었는지 확인한다.

재시작 시에는 메모리 상태를 신뢰하지 않고 KIS의 미체결 주문/체결/잔고를 조회하여 내부 상태를 재구성한다.

## 8. 인증 및 보안

다음 값은 Git에 절대 저장하지 않는다.

```text
APP_KEY
APP_SECRET
KIS_ACCESS_TOKEN
계좌번호
개인 식별정보
```

Cloudflare Worker Secret 또는 배포 플랫폼의 안전한 Secret 저장소에서 `APP_KEY` / `APP_SECRET`을 주입한다.

브라우저에는 KIS App Secret을 전달하지 않는다.

로그에는 인증 헤더, Secret, Access Token, 전체 계좌번호를 남기지 않는다.

## 9. 오류 처리

외부 API 오류는 내부 오류 유형으로 변환한다.

```text
AUTH_ERROR
RATE_LIMITED
TIMEOUT
NETWORK_ERROR
INVALID_REQUEST
BROKER_REJECTED
DATA_INVALID
BROKER_UNAVAILABLE
UNKNOWN
```

재시도 가능한 오류만 제한된 횟수와 backoff를 적용한다. 주문 전송처럼 중복 위험이 있는 작업은 무조건 자동 재시도하지 않고 주문 상태를 먼저 확인한다.

## 10. 데이터 신뢰성

각 시세에는 다음 정보를 유지한다.

- 데이터 출처
- 조회 시각
- 시장 기준 시각
- 실시간/지연 여부
- 시장 상태

다음 상태에서는 신규 자동주문을 차단할 수 있어야 한다.

- 시세가 일정 시간 이상 갱신되지 않음
- 필수 필드 누락
- 비정상 가격/수량
- KIS API 오류
- 계좌와 내부 포지션 불일치

## 11. 감사 로그

최소 다음 이벤트를 추적한다.

```text
STRATEGY_SIGNAL
RISK_APPROVED
RISK_BLOCKED
ORDER_CREATED
ORDER_SUBMITTED
ORDER_ACCEPTED
ORDER_REJECTED
ORDER_PARTIAL_FILL
ORDER_FILLED
ORDER_CANCELED
RECONCILIATION
SYSTEM_ERROR
EMERGENCY_STOP
```

로그는 원인과 결과를 추적할 수 있어야 하며 민감정보는 마스킹한다.

## 12. 프론트엔드와 API 계약

초기 시세 API:

```text
GET /quote?symbol=005930
GET /quotes?symbols=005930,000660
```

향후 API 영역:

```text
GET  /account
GET  /positions
GET  /orders
GET  /orders/:id
POST /orders
POST /orders/:id/cancel
GET  /trading/status
POST /trading/start
POST /trading/stop
POST /trading/emergency-stop
```

주문 API는 인증된 서버 환경에서만 실행하고, UI는 서버 API를 통해 요청한다.

## 13. 폴더 구조 방향

현재 구조를 유지하면서 자동매매 영역을 점진적으로 추가한다.

```text
/
├─ .github/workflows/
├─ docs/
│  ├─ agent.md 관련 프로젝트 지침은 루트 agent.md
│  ├─ roadmap.md
│  ├─ design.md
│  ├─ api-strategy.md
│  ├─ trading.md
│  └─ operations.md
├─ src/
│  ├─ components/
│  ├─ data/
│  ├─ services/
│  ├─ types/
│  └─ styles/
├─ workers/
│  └─ quote-api/
│     ├─ src/
│     └─ wrangler.toml
└─ agent.md
```

자동매매 구현이 시작되면 Worker 내부에서도 `auth`, `quote`, `account`, `order`, `risk`, `strategy`, `reconciliation` 영역을 분리한다. 현재 코드보다 앞서 구조를 과도하게 확장하지 않는다.

## 14. 구현 순서

1. KIS 인증/환경 분리
2. 시세 Adapter 안정화
3. 계좌/포지션 읽기
4. 주문 도메인/상태 머신
5. DRY_RUN 시뮬레이터
6. Risk Manager/Kill Switch
7. KIS 모의투자 주문
8. 전략/백테스트
9. 자동 실행 스케줄러
10. 실계좌 활성화 게이트
11. 모니터링/복구
12. 운영 안정화

각 단계는 이전 단계의 테스트가 통과된 후 진행한다.

## 15. 설계상 금지사항

- 브라우저에 KIS App Secret 포함
- 전략 코드에서 KIS API 직접 호출
- HTTP 200을 체결 완료로 간주
- UNKNOWN 주문의 무조건 재전송
- 계좌/포지션 불일치 상태에서 신규 주문
- stale 시세 기반 자동주문
- 실계좌를 기본 실행 모드로 사용
- 실제 주문 검증을 위해 사용자의 실계좌를 테스트 대상으로 사용
- 수익률을 보장하는 표현
