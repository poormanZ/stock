# 한국투자증권 자동 주식매매 개발 로드맵

> 기준일: 2026-09-14  
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
- [ ] 모의투자 주문 안정성 검증
- [ ] 전략/백테스트
- [ ] 실계좌 주문

## Phase 1 — KIS 인증/어댑터
- [x] `PAPER` / `LIVE` 환경 분리
- [x] `APP_KEY` / `APP_SECRET` Secret 주입
- [x] Access Token 발급·캐시·만료 처리
- [x] 국내주식 시세 Adapter
- [x] KIS 오류 응답 변환
- [x] timeout / retry / rate-limit 정책

## Phase 2 — 시세 서비스 / 프론트엔드
- [x] `/quote`, `/quotes` 계약
- [x] 종목 코드 검증
- [x] stale/missing 시세 정책
- [x] Cloudflare Worker 배포
- [x] GitHub Pages → Worker 연동
- [x] 실제 KIS 시세 통합 테스트
- [x] GitHub Pages 시세/계좌/DRY_RUN 통합 대시보드

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

## Phase 7 — 모의투자 자동매매
- [x] 모의투자 주문 Adapter
- [x] 주문/체결 조회
- [x] LIVE/PAPER 환경 분리 검증
- [x] 장 운영시간 처리
- [x] 실패/UNKNOWN 복구 1차 처리
- [x] 부분체결/취소 복구
- [ ] 일정 기간 안정성 검증

## Phase 8 — 전략 / 백테스트
- [ ] Strategy 인터페이스
- [ ] 진입/청산 조건
- [ ] 포지션 사이징
- [ ] 손절/익절 규칙
- [ ] 과거 데이터 백테스트
- [ ] 수수료/세금/슬리피지 반영
- [ ] 수익률/승률/최대낙폭/손익비 지표

## Phase 9 — 자동 실행 스케줄러
- [ ] 실행 주기/트리거
- [ ] 중복 실행 방지/Lock
- [ ] 실행 이력
- [ ] 장애 후 재개
- [ ] 장 시작/종료 처리
- [ ] 장외 신규주문 차단

## Phase 10 — 실계좌 매매 게이트
- [ ] 기본값 `LIVE` 금지
- [ ] 명시적 `LIVE_TRADING_ENABLED` 확인
- [ ] 계좌 환경 일치 확인
- [ ] Risk Manager / Kill Switch 확인
- [ ] 장 상태 확인
- [ ] 주문 한도 확인
- [ ] 사용자 명시적 활성화 절차
- [ ] 모의투자 안정성 검증 후에만 활성화

## Phase 11 — 모니터링 / 감사 / 복구
- [ ] 주문/전략/Risk/KIS 오류/체결 감사 로그
- [ ] 계좌 reconciliation 로그
- [ ] 민감정보 마스킹
- [ ] 장애 알림
- [ ] 재시작 복구
- [ ] UNKNOWN 주문 자동 reconciliation

## Phase 12 — 품질 / 운영 안정화
- [ ] 단위/통합 테스트
- [ ] KIS API 장애 테스트
- [ ] token 만료 테스트
- [ ] 중복 주문/부분체결 테스트
- [ ] 재시작/잔고 불일치 테스트
- [ ] 빌드/배포 자동 검증
- [ ] 보안 점검
- [ ] 운영 매뉴얼 및 실거래 전 체크리스트

## 현재 다음 작업

### 1순위 — DRY_RUN 장외시간 회귀 검증

최근 `/dry-run/orders`를 KIS 외부 조회와 완전히 분리했다. 다음 단계는 실제 Worker 엔드포인트에서 장외시간 주문을 호출해 성공 여부를 확인하고, Risk Manager 및 Kill Switch 거부도 함께 회귀 검증하는 것이다.

### 2순위 — Phase 7 PAPER 주문 안정성 검증

PAPER 신규 주문은 한국시간(KST) 기준 평일 09:00~15:30 정규장에만 전송되도록 Worker 단계에서 차단한다. 주말과 장외 시간에는 KIS 주문 API까지 요청하지 않고 `MARKET_SESSION_CLOSED`를 반환한다. `/paper/reconcile`는 장외에서도 상태 복구를 위해 계속 호출할 수 있다.

현재 Worker의 `KIS_ENVIRONMENT`는 `LIVE`이므로 `/paper/orders`와 `/paper/reconcile`는 실제 운영 환경에서 PAPER 작업을 수행하지 않는다. LIVE 주문 API는 계속 추가하지 않는다.

### 3순위 — 일정 기간 안정성 검증

PAPER 주문의 성공/거부/UNKNOWN/부분체결/취소/재시작 복구를 일정 기간 반복 검증한 뒤 전략 및 백테스트 단계로 이동한다.
