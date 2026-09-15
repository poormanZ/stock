# 한국투자증권 자동 주식매매 개발 로드맵

> 기준일: 2026-09-15  
> 기준 브랜치: `main`

## 현재 상태

- [x] KIS 인증/Access Token 캐시 및 24시간 재사용
- [x] 국내 위탁계좌 상품코드 `01` 적용
- [x] LIVE `/account`, `/account/assets`, `/buyable` 조회
- [x] 읽기 전용 `/orders` 조회
- [x] LIVE/PAPER 주문용 reconciliation 및 신규주문 Gate
- [x] `Order` 도메인 상태 머신
- [x] Durable Object 내부 상태 저장소
- [x] DRY_RUN 가상 현금/포지션/주문 시뮬레이터
- [x] DRY_RUN 주문 경로를 KIS reconciliation/시세 조회와 분리
- [x] GitHub Pages용 시세/계좌/DRY_RUN 주문 통합 UI
- [x] 종목별 최대 수량/주문금액 Risk Manager
- [x] 전체 포지션 한도 Risk Manager
- [x] 일일 주문 횟수/손실 한도 Risk Manager
- [x] 시세 지연/누락 차단
- [x] API 장애/계좌 불일치 주문 차단
- [x] 긴급 정지(Kill Switch) Durable Object 저장
- [x] DRY_RUN 주문 경로 Risk Manager 연결
- [x] PAPER 주문 Adapter 기본 전송 경로
- [x] PAPER 주문도 reconciliation Gate + Risk Manager 통과
- [x] PAPER 주문 clientOrderId 멱등성 및 UNKNOWN 상태 처리
- [x] Worker 타입체크(`tsc` + `@cloudflare/workers-types`) 및 라우터/HTTP 클라이언트 테스트
- [x] 수정된 CORS preflight / PAPER 위험검사 경로 배포 후 실측 검증
- [x] PAPER 내부 포지션을 KIS 계좌 스냅샷에서 명시적으로 동기화하는 경로
- [x] LIVE KST 일일 실현손익 산출 Adapter 1차 (`TTTC8715R`)
- [x] 손익 데이터 미확인 시 Risk Manager fail-closed
- [ ] PAPER 주문 경로에 검증된 dailyLoss 공급 연결
- [x] 전략 인터페이스 / SMA 교차 전략 / 손절·익절 / 포지션 사이징 / 일봉 백테스트
- [x] 자동 실행 스케줄러(Cron, DO lease, 실행 이력, ERROR/EMERGENCY_STOP 전이)
- [x] 감사 로그 / webhook 알림 / 체결 증분 포지션 원장 / PAPER 일일 실현손실
- [x] 실계좌 주문 게이트(기본 비활성, 명시적 arm + 확인 문구) 및 LIVE 어댑터
- [x] 대시보드 재구성(상태 스트립·요약·이력 탭) 및 자동매매 매수/매도 사유 표시
- [ ] 모의투자 주문 안정성 검증 (기간 필요)
- [ ] 실계좌 주문 활성화 (PAPER 검증 후 운영자 결정. `docs/operations.md` §8 체크리스트)

## Phase 1 — KIS 인증/어댑터
- [x] `PAPER` / `LIVE` 환경 분리
- [x] `APP_KEY` / `APP_SECRET` Secret 주입
- [x] Access Token 발급·캐시·만료 처리
- [x] 국내주식 시세 Adapter
- [x] KIS 오류 응답 변환
- [x] timeout / retry / rate-limit 정책
- [x] LIVE 기간별매매손익 Adapter
- [ ] PAPER 기간별매매손익 지원 여부 검증

## Phase 2 — 시세 서비스 / 프론트엔드
- [x] `/quote`, `/quotes` 계약
- [x] 종목 코드 검증
- [x] stale/missing 시세 정책
- [x] Cloudflare Worker 배포
- [x] GitHub Pages → Worker 연동
- [x] 실제 KIS 시세 통합 테스트
- [x] GitHub Pages 시세/계좌/DRY_RUN 통합 대시보드
- [x] 대시보드 모듈 분리(`views/`, `api/`, `format.ts`), 상태 한글 라벨, 이력 탭, 자동 새로고침

## Phase 3 — 계좌/잔고/포지션
- [x] `inquire-balance` (`TTTC8434R` / `VTTC8434R`)
- [x] 예수금/정산금액/평가/순자산 모델
- [x] 보유 종목/수량/평균단가 모델
- [x] `inquire-psbl-order` (`TTTC8908R` / `VTTC8908R`)
- [x] LIVE 계좌 조회 검증
- [x] `inquire-daily-ccld` 기반 읽기 전용 `/orders`
- [x] KIS ↔ 내부 reconciliation
- [x] Durable Object 내부 상태 저장
- [x] 신규주문 Gate
- [x] DRY_RUN을 KIS reconciliation과 분리
- [x] PAPER 명시적 포지션 스냅샷 동기화 (`POST /paper/position-sync`)

## Phase 4 — 주문 도메인
- [x] `Order` 도메인 모델
- [x] 매수/매도 요청 모델
- [x] 주문 상태 정의
- [x] `clientOrderId` 모델
- [x] 부분체결 상태 전이
- [x] 거부/취소/UNKNOWN 상태 전이
- [x] 주문 생성 → 전송의 PAPER 기본 흐름
- [x] 주문 생성 → 전송 → 조회 → 취소 전체 흐름
- [x] 주문 상태 재동기화

## Phase 5 — DRY_RUN
- [x] 가상 현금/보유 포지션
- [x] 시장가/지정가 시뮬레이션
- [x] 수수료/세금/슬리피지
- [x] 부분체결 시뮬레이션
- [x] 주문 이력 및 재시작 복구
- [x] 실제 주문 Adapter와 동일한 내부 계약
- [x] GitHub Pages DRY_RUN 주문 UI
- [x] DRY_RUN 주문에서 KIS 계좌/주문내역/실시간 시세 조회 제거
- [x] DRY_RUN 장 운영시간 독립 처리

## Phase 6 — 위험관리 / Kill Switch
- [x] 종목별 최대 수량/주문금액
- [x] 전체 포지션 한도
- [x] 일일 주문 횟수/손실 한도
- [x] 시세 지연/누락 차단
- [x] API 장애 차단
- [x] 계좌 불일치 차단
- [x] 긴급 정지 상태 저장
- [x] 모든 DRY_RUN 주문 경로가 Risk Manager를 통과하도록 보장
- [x] PAPER 주문 경로에도 동일 Risk Manager 연결
- [x] dailyLoss 계산 순수 로직
- [x] dailyLoss 미확인 fail-closed 방어
- [ ] PAPER 검증된 dailyLoss 공급 연결

## Phase 7 — 모의투자 자동매매
- [x] 모의투자 주문 Adapter
- [x] 주문/체결 조회
- [x] LIVE/PAPER 환경 분리 검증
- [x] 장 운영시간 처리
- [x] 실패/UNKNOWN 복구 1차 처리
- [x] 부분체결/취소 복구
- [x] 내부 포지션 명시적 스냅샷 동기화
- [ ] 일정 기간 안정성 검증

## Phase 8 — 전략 / 백테스트
- [x] Strategy 인터페이스 (`strategy.ts`, 순수 함수)
- [x] 진입/청산 조건 (SMA 교차 전략)
- [x] 포지션 사이징 (현금 비율·주문금액·수량·포지션 한도)
- [x] 손절/익절 규칙
- [x] 과거 데이터 백테스트 (KIS 일봉 `GET /candles`, `POST /backtest`)
- [x] 수수료/세금/슬리피지 반영 (DRY_RUN 비용 모델 공유)
- [x] 수익률/승률/최대낙폭/손익비 지표
- [ ] 추가 전략 (모멘텀, 변동성 돌파 등)

## Phase 9 — 자동 실행 스케줄러
- [x] 실행 주기/트리거 (Cron `*/5 0-6 * * 1-5`, `POST /trading/run` 수동)
- [x] 중복 실행 방지/Lock (DO lease 120초)
- [x] 실행 이력 (`GET /trading/runs`, 50건)
- [x] 장애 후 재개 (lease 만료, ERROR 상태 → 운영자 start)
- [x] 장 시작/종료 처리 (PAPER는 정규장만 실행)
- [x] 장외 신규주문 차단 (PAPER 경로 MARKET_SESSION_CLOSED)
- [ ] 운영 환경에서 Cron 실행 실측

## Phase 10 — 실계좌 매매 게이트
- [x] 기본값 `LIVE` 금지 (플래그 미설정 시 403 `LIVE_TRADING_DISABLED`, KIS 호출 없음)
- [x] 명시적 `LIVE_TRADING_ENABLED` 확인 (정확히 `true`)
- [x] 계좌 환경 일치 확인 (`KIS_ENVIRONMENT=LIVE`, 계좌 설정)
- [x] Risk Manager / Kill Switch 확인
- [x] 장 상태 확인
- [x] 주문 한도 확인 (Risk Manager 공유, LIVE 일일손실은 KIS 기간별매매손익)
- [x] 사용자 명시적 활성화 절차 (`POST /live/arm` 확인 문구 + 15분 TTL, 주문마다 확인 문구)
- [x] 모의투자 안정성 검증 후에만 활성화 (`PAPER_VERIFICATION_DATE` 필수)
- [ ] 운영자 체크리스트 완료 후 실제 활성화 (`docs/operations.md` §8)

## Phase 11 — 모니터링 / 감사 / 복구
- [x] 주문/전략/Risk/KIS 오류/체결 감사 로그 (`GET /audit`, 500건)
- [x] 계좌 reconciliation 로그
- [x] 민감정보 마스킹 (인증정보·8자리 계좌번호)
- [x] 장애 알림 (`ALERT_WEBHOOK_URL`)
- [x] 재시작 복구 (DO 영속 상태, lease 만료, 재시작 복구 테스트)
- [x] UNKNOWN 주문을 `/paper/reconcile`에서 RECONCILING 경유로 복구 (수동 호출)
- [x] UNKNOWN 주문 자동 reconciliation (PAPER 스케줄 사이클 시작 시 resync)

## Phase 12 — 품질 / 운영 안정화
- [x] 순수 로직 단위 테스트 (상태 머신, Risk Manager, reconciliation, 시뮬레이터, 어댑터 계약, 라우터)
- [x] 실제 KIS PAPER 환경 통합 테스트 골격 (`npm run test:integration`, 환경변수 있을 때만 실행, 읽기 전용)
- [ ] 실제 KIS PAPER 환경 통합 테스트 실행
- [x] KIS 5xx/429/인증 실패 처리 테스트 (HTTP 클라이언트)
- [x] token 만료 해석(KST)·재발급 테스트
- [x] 중복 주문(POST 비재시도, clientOrderId 멱등성)/부분체결 resync 테스트
- [x] 재시작/잔고 불일치 테스트 (DO 재생성 복구, `/reconciliation` KIS stub 불일치)
- [x] 빌드/배포 자동 검증 (Worker: check → test → deploy, Pages: test → build)
- [ ] 보안 점검 (외부 감사)
- [x] 운영 매뉴얼 및 실거래 전 체크리스트 (`docs/operations.md`)

## 현재 다음 작업

### 완료 — 배포 후 실측 검증

2026-09-15 배포 후 실측에서 수정된 CORS preflight / 위험검사 경로를 확인했다.

### 완료 — 내부 포지션 동기화 정책 및 구현 1차

내부 포지션은 자동 주문 경로에서 KIS 스냅샷으로 조용히 덮어쓰지 않고 운영자가 명시적으로 동기화할 때만 반영한다.

### 완료 — `dailyLoss` 산출 기반 1차

KIS 공식 샘플에서 확인되는 LIVE `TTTC8715R` 기간별매매손익 API를 사용하도록 Adapter를 추가했다. KST 거래일의 `rlzt_pfls`에서 `fee`, `tl_tax`, `loan_int`를 차감한 순실현손익을 계산하고, 음수일 때만 `dailyLoss`로 변환한다.

또한 PAPER용 TR ID를 추측하지 않도록 PAPER에서는 손익 데이터 미확인을 `DAILY_LOSS_UNAVAILABLE`로 표현할 수 있게 Risk Manager를 fail-closed로 강화했다.

### 완료 — PAPER dailyLoss 공급 연결

PAPER는 KIS 기간별매매손익 조회를 제공하지 않으므로 체결 증분 기반 원장(`position-ledger.ts`)으로 당일 실현손익을 계산해 Risk Manager에 공급한다. `/paper/reconcile`(또는 스케줄러 resync)에서 체결이 확정될 때 포지션·평균단가·실현손익이 갱신되고, 기준선은 `POST /paper/position-sync`(평균단가 포함)로 만든다. LIVE는 `TTTC8715R`을 그대로 사용하며, 어느 공급원도 없으면 `DAILY_LOSS_UNAVAILABLE`로 차단한다(fail-closed).

### 다음 1순위 — 배포 후 실측 (스케줄러·감사 로그·CANCEL_PENDING)

push → `v5` 마이그레이션(AuditLogStoreDO, TradingStateStoreDO) 적용 확인 → `GET /trading/status`, `GET /live/status`(=`LIVE_TRADING_DISABLED`), `GET /audit` 확인 → Pages UI에서 DRY_RUN 자동매매 시작 → 5분 Cron 실행 이력·감사 로그를 며칠 관찰한다.

### 2순위 — PAPER 주문 안정성 검증 (Phase 7)

PAPER 신규 주문은 한국시간(KST) 기준 평일 09:00~15:30 정규장에만 전송되도록 Worker 단계에서 차단한다. `/paper/reconcile`와 `/paper/position-sync`는 장외에서도 상태 복구/동기화를 위해 호출할 수 있다.

현재 Worker의 `KIS_ENVIRONMENT`는 `LIVE`이므로 실제 운영 Worker에서는 PAPER 주문 경로를 수행하지 않는다. LIVE 주문 API는 계속 추가하지 않는다.

통과 기준과 실계좌 활성화 절차는 `docs/operations.md` §8 체크리스트를 따른다. 실계좌 활성화는 코드 변경 없이 Secret(`LIVE_TRADING_ENABLED`, `PAPER_VERIFICATION_DATE`)으로만 제어하며 운영자 결정 사항이다.
