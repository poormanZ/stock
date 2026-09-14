# 한국투자증권 자동 주식매매 개발 로드맵

> 기준일: 2026-09-14  
> 기준 브랜치: `main`

## 1. 개발 원칙

- 실제 주문보다 **안전한 모의/드라이런 검증**을 먼저 완료한다.
- 각 단계는 코드·테스트·문서를 함께 갱신한다.
- 완료 표시는 실제 저장소의 구현과 검증이 끝난 경우에만 한다.
- KIS 인증정보와 계좌정보는 Git 저장소 및 브라우저에 저장하지 않는다.
- 실계좌 주문은 마지막 단계에서 별도의 다중 안전장치와 명시적 활성화 절차를 거친다.

## 2. 현재 상태

- [x] 프로젝트 목표를 KIS 자동매매 시스템으로 재정의
- [x] `agent.md` 자동매매 개발 지침 작성
- [x] 기존 Vite + TypeScript 대시보드 유지
- [x] Cloudflare Worker 기반 KIS 시세 Proxy
- [x] KIS Access Token 캐시/24시간 재사용 구조
- [x] 전체 자동매매 아키텍처 문서 정비
- [x] KIS Worker Secret 이름을 `APP_KEY` / `APP_SECRET`으로 표준화
- [x] 계좌 Secret 이름을 `ACCOUNT_NUM`으로 표준화
- [x] 실제 KIS 시세 연결 검증
- [x] 국내 위탁계좌 상품코드 `01` 적용
- [x] `/account` 실제 LIVE 계좌 조회 연결
- [x] `/account/assets` 실제 LIVE 자산 조회 연결
- [x] `/buyable` 실제 LIVE 국내주식 매수가능 조회 연결
- [x] 읽기 전용 `/orders` 국내주식 주문/체결내역 조회 연결
- [x] reconciliation 비교 모델 및 신규주문 차단 판정 로직
- [x] `Order` 도메인 모델 및 상태 전이 검증
- [x] Durable Object 기반 내부 주문/포지션 상태 저장소
- [x] `/reconciliation` 실제 KIS 조회 ↔ 내부 상태 비교 연결
- [x] KIS/내부 주문 누락도 불일치로 판정
- [x] 신규주문 reconciliation Gate 공통 모듈 및 테스트
- [ ] 불일치 경고 및 신규주문 차단을 실제 주문 경로에 연결
- [ ] DRY_RUN 주문 시뮬레이터
- [ ] 위험관리 및 Kill Switch
- [ ] 모의투자 주문
- [ ] 전략/백테스트
- [ ] 실계좌 주문

## 3. 단계별 로드맵

### Phase 0 — 프로젝트 기반 정비
- [x] `agent.md` 작성
- [x] `docs/design.md` 작성
- [x] `docs/api-strategy.md` 작성
- [x] `docs/roadmap.md` 작성
- [x] README 갱신

### Phase 1 — KIS 인증/어댑터 표준화
- [x] `PAPER` / `LIVE` 환경 분리
- [x] `APP_KEY` / `APP_SECRET` Secret 주입
- [x] Access Token 발급·캐시·만료 처리
- [x] 공통 HTTP 클라이언트
- [x] 국내주식 시세 Adapter
- [x] KIS 오류 응답 변환
- [x] timeout / retry / rate-limit 정책
- [x] 인증정보 로그 마스킹 테스트

### Phase 2 — 시세 서비스 안정화
- [x] `/quote`, `/quotes` 계약 확정
- [x] 종목 코드 검증
- [x] KIS 시세 응답 검증 및 변환
- [x] `asOf` 및 stale/missing 정책
- [x] Cloudflare Worker 배포
- [x] GitHub Pages → Worker 연동
- [x] 프론트엔드 Worker 호출
- [x] 실제 KIS 시세 통합 테스트

### Phase 3 — 계좌/잔고/포지션
목표: 실제 계좌 상태를 읽기 전용으로 정확하게 모델링하고, 주문 전에 내부 상태와 대조할 수 있는 기반을 만든다.

- [x] `inquire-balance` (`TTTC8434R` / `VTTC8434R`)
- [x] 예수금/정산금액/평가/순자산 모델
- [x] 보유 종목/수량/평균단가 모델
- [x] 서버 기준 포지션 모델
- [x] `inquire-psbl-order` (`TTTC8908R` / `VTTC8908R`)
- [x] 실제 LIVE 계좌 조회 검증
- [x] 실제 국내 주문가능 현금 0원 상태 검증
- [x] `inquire-daily-ccld` 기반 읽기 전용 `/orders` 연결
- [x] KIS 포지션/주문과 내부 상태를 비교하는 순수 reconciliation 모델
- [x] Durable Object 내부 상태 저장소 연결
- [x] `/reconciliation`에서 KIS 상태와 내부 상태 비교
- [x] 신규주문 Gate 공통 모듈
- [ ] 불일치 시 신규 주문 차단을 실제 주문 경로에 연결

### Phase 4 — 주문 도메인
목표: 주문을 KIS API와 독립적인 내부 상태 머신으로 관리한다.

- [x] `Order` 도메인 모델
- [x] 매수/매도 주문 요청 모델
- [x] 주문 상태 정의
- [x] 주문 식별자/중복 방지용 `clientOrderId` 모델
- [ ] 주문 생성 → 전송 → 조회 → 취소 흐름
- [x] 부분체결 상태 전이 검증
- [x] 거부/취소/알 수 없음 상태 전이 정의
- [x] `UNKNOWN → RECONCILING` 상태 전이 정의
- [ ] 주문 상태 재동기화

### Phase 5 — DRY_RUN 시뮬레이터
- [ ] 가상 현금/보유 포지션
- [ ] 시장가/지정가 시뮬레이션
- [ ] 수수료/세금/슬리피지
- [ ] 체결/부분체결 시뮬레이션
- [ ] 주문 이력 및 재시작 복구
- [ ] 실제 주문 Adapter와 동일한 내부 계약 사용

### Phase 6 — 위험관리 / Kill Switch
- [ ] 종목별 최대 수량/주문금액
- [ ] 전체 포지션 한도
- [ ] 일일 주문 횟수/손실 한도
- [ ] 시세 지연/누락 차단
- [ ] API 장애 차단
- [ ] 계좌 불일치 차단
- [ ] 긴급 정지 상태 저장
- [ ] 모든 주문 경로가 Risk Manager를 통과하도록 보장

### Phase 7 — 모의투자 자동매매
- [ ] 모의투자 주문 Adapter
- [ ] 주문/체결 조회
- [ ] 실계좌와 모의계좌 환경 분리 검증
- [ ] 장 운영시간 처리
- [ ] 실패/부분체결/취소 복구
- [ ] 일정 기간 안정성 검증

### Phase 8 — 전략 엔진 / 백테스트
- [ ] Strategy 인터페이스
- [ ] 진입/청산 조건
- [ ] 포지션 사이징
- [ ] 손절/익절 규칙
- [ ] 과거 데이터 백테스트
- [ ] 수수료/세금/슬리피지 반영
- [ ] 수익률/승률/최대낙폭/손익비 지표

### Phase 9 — 자동 실행 스케줄러
- [ ] 실행 주기/트리거
- [ ] 중복 실행 방지/Lock
- [ ] 실행 이력
- [ ] 장애 후 재개
- [ ] 장 시작/종료 처리
- [ ] 장외 신규주문 차단
- [ ] Cloudflare Worker 적합성 검증

### Phase 10 — 실계좌 매매 게이트
- [ ] 기본값 `LIVE` 금지
- [ ] 명시적 `LIVE_TRADING_ENABLED` 확인
- [ ] 계좌 환경 일치 확인
- [ ] 위험관리/ Kill Switch 확인
- [ ] 장 상태 확인
- [ ] 주문 한도 확인
- [ ] 사용자 명시적 활성화 절차
- [ ] 모의투자 안정성 검증 후에만 활성화

### Phase 11 — 모니터링/감사/복구
- [ ] 주문/전략/Risk/KIS 오류/체결 감사 로그
- [ ] 계좌 reconciliation 로그
- [ ] 민감정보 마스킹
- [ ] 장애 알림
- [ ] 재시작 복구
- [ ] UNKNOWN 주문 자동 reconciliation

### Phase 12 — 품질/운영 안정화
- [ ] 단위/통합 테스트
- [ ] KIS API 장애 테스트
- [ ] token 만료 테스트
- [ ] 중복 주문/부분체결 테스트
- [ ] 재시작/잔고 불일치 테스트
- [ ] 빌드/배포 자동 검증
- [ ] 보안 점검
- [ ] 운영 매뉴얼 및 실거래 전 체크리스트

## 4. 현재 다음 작업

**Phase 4 → Phase 5 진입 준비**.

현재 실제 LIVE 계좌에 대해 다음 읽기 전용 연결이 검증되었다.

1. `/account` — 국내주식 잔고/예수금/포지션
2. `/account/assets` — 계좌 전체 자산 구성
3. `/buyable` — 종목별 국내주식 주문가능 금액/수량
4. `/orders` — 국내주식 주문/체결 내역
5. reconciliation — KIS 상태와 내부 상태의 차이를 계산하고 신규 주문 가능 여부를 판정
6. Order domain — KIS와 독립적인 주문 상태/전이 계약
7. Internal State Store — Durable Object로 내부 상태를 영속 저장
8. Order Gate — 신규 주문 전에 reconciliation 및 주문 형식을 검증하는 공통 차단 계층

현재 실제 계좌는 국내 현금과 국내주식 보유가 0이고 해외 달러 자산만 존재하므로, `/buyable`의 국내 주문가능 현금 0원은 정상적인 상태다. 해외 자산 총액을 국내 주문가능 현금으로 간주하지 않는다.

다음 구현 단위:

1. DRY_RUN 주문 경로를 만들고 Order Gate를 실제 신규주문 흐름에 연결
2. 가상 현금/보유 포지션과 시장가·지정가 체결 시뮬레이션
3. 수수료/세금/슬리피지 및 부분체결 모델
4. DRY_RUN 상태 영속화 및 재시작 복구
5. 이후 Risk Manager + Kill Switch를 DRY_RUN 경로에 강제 연결

## 5. 완료 판정

각 Phase는 다음 조건을 모두 만족해야 한다.

- 코드가 `main`에 반영됨
- 관련 문서가 최신 코드와 일치함
- 자동 테스트 또는 정적 검증 통과
- 실패/장애 경로 확인
- 보안상 민감정보가 저장소에 없음
- 다음 Phase를 시작할 수 있는 전제조건 확보
