# 현재 개발 상태

> 기준일: 2026-09-14
> 기준 브랜치: `main`
> 정리 기준 커밋: `7fbdb948d3b32c43c68306eb823d7579293288b7`

## 1. 프로젝트 목표

한국투자증권(KIS) API를 기반으로 한 자동 주식매매 시스템을 단계적으로 구축한다. 현재는 **LIVE 환경에서 조회 기능을 운영하고, DRY_RUN으로 주문·위험관리 로직을 검증하며, PAPER 주문 경로를 별도로 개발/검증하는 단계**다.

실계좌 주문 API는 아직 구현하지 않으며, 안정성 검증이 끝나기 전에는 실거래를 활성화하지 않는다.

## 2. 현재 환경

- 기본 브랜치: `main`
- 현재 Worker 환경: `KIS_ENVIRONMENT=LIVE`
- 국내주식 계좌 상품코드: `01`
- GitHub Pages 프론트엔드 → Cloudflare Worker API 구조
- KIS Access Token은 캐시를 활용해 24시간 재사용하는 구조
- LIVE 주문 API는 구현/호출하지 않음

## 3. 완료된 핵심 기능

### KIS 인증 / API

- `PAPER` / `LIVE` 환경 분리
- `APP_KEY`, `APP_SECRET` Secret 주입
- Access Token 발급 및 캐시
- 토큰 만료 처리 및 24시간 재사용
- 국내주식 시세 조회
- KIS 오류 변환
- timeout / retry / rate-limit 정책

### 계좌 / 시세

- `/quote`, `/quotes`
- 종목코드 검증
- stale/missing 시세 차단
- `/account`
- `/account/assets`
- `/buyable`
- 읽기 전용 `/orders`
- KIS 계좌 ↔ 내부 상태 reconciliation

### 주문 도메인

- `Order` 상태 머신
- 매수/매도 요청 모델
- `clientOrderId`
- 부분체결 / 거부 / 취소 / UNKNOWN 상태
- 주문 생성 → 전송 → 조회 → 취소 흐름
- 주문 상태 재동기화
- Durable Object 기반 내부 상태 저장

### DRY_RUN

- 가상 현금 / 포지션 / 주문
- 시장가 / 지정가 시뮬레이션
- 수수료 / 세금 / 슬리피지
- 부분체결
- 주문 이력 및 재시작 복구
- GitHub Pages 주문 UI
- Risk Manager 연결
- Kill Switch 연결

#### DRY_RUN 장외시간 문제 수정

기존 `/dry-run/orders`는 reconciliation 및 KIS 실시간 시세 조회를 먼저 수행했기 때문에 장외시간·주말에도 외부 KIS API 상태에 영향을 받을 수 있었다.

현재는 다음과 같이 완전히 분리했다.

- KIS 계좌 조회하지 않음
- KIS 주문내역 조회하지 않음
- KIS 실시간 시세 조회하지 않음
- reconciliation 조회하지 않음
- 장 운영시간에 의존하지 않음
- 요청의 `referencePrice`를 시뮬레이션 가격으로 사용
- 현재 시각을 DRY_RUN quote timestamp로 사용해 stale quote 검사를 만족
- Risk Manager의 주문수량/주문금액/포지션/일일한도 검사는 유지
- Kill Switch는 계속 적용
- DRY_RUN Durable Object에서 최종 시뮬레이션 처리

따라서 DRY_RUN은 장외시간에도 KIS 장 상태와 무관하게 동작하는 것이 목표이며, LIVE/PAPER 주문 안전장치는 변경하지 않는다.

### PAPER

- PAPER 주문 Adapter
- reconciliation Gate
- Risk Manager
- `clientOrderId` 멱등성
- UNKNOWN 상태 처리
- 주문/체결 조회
- 부분체결/취소 복구
- 장 운영시간 처리

현재 Worker 자체가 `LIVE` 환경이므로 PAPER 주문 전송을 실제 운영환경에서 수행하지 않는다.

## 4. 위험관리 상태

현재 Risk Manager에는 다음 방어 로직이 연결되어 있다.

- 종목별 최대 주문 수량
- 종목별 최대 주문금액
- 전체 포지션 한도
- 일일 주문 횟수 한도
- 일일 손실 한도
- stale quote 차단
- API 장애 차단
- reconciliation 불일치 차단
- Kill Switch

DRY_RUN은 KIS reconciliation을 사용하지 않지만, **Risk Manager 자체의 제한과 Kill Switch는 그대로 적용**한다.

## 5. LIVE / PAPER / DRY_RUN 역할 구분

| 영역 | 목적 | KIS 외부 주문 | 장시간 의존 |
|---|---|---:|---:|
| DRY_RUN | 로컬/가상 주문 검증 | 없음 | 없음 |
| PAPER | KIS 모의투자 주문 검증 | 있음 | 있음 |
| LIVE | 실제 계좌 조회/운영 기반 | 현재 주문 미구현 | 실제 운영 규칙 적용 |

핵심 원칙은 **DRY_RUN을 KIS와 분리하고, PAPER/LIVE의 안전장치를 약화시키지 않는 것**이다.

## 6. 최근 변경 이력

### `772b470bfa2090434af96584476fbd67fcacaf1f`

`fix: isolate DRY_RUN from KIS trading-hours dependencies`

- `/dry-run/orders`에서 `loadReconciliation()` 제거
- `/dry-run/orders`에서 `KISQuoteAdapter` 제거
- DRY_RUN 자체 상태와 Risk Manager만 사용
- `referencePrice` 기반 시뮬레이션
- 장외시간에도 동작할 수 있도록 외부 KIS 의존성 제거

### `7fbdb948d3b32c43c68306eb823d7579293288b7`

`chore: remove one-time DRY_RUN patch workflow`

- 일회성 DRY_RUN 자동 패치 Workflow 제거
- 실제 소스 변경이 `main`에 반영된 이후 불필요한 자동 패치 경로 제거

## 7. 검증 상태

최근 DRY_RUN 분리 변경에 대한 Quote Worker Actions Run은 테스트 단계가 성공했고 배포 단계까지 진행되었다.

- Actions Run: `34894000395`
- Test job: 성공
- Deploy job: 배포 진행 확인

다만 실제 브라우저에서 장외시간 DRY_RUN 주문을 직접 실행하는 외부 런타임 검증은 아직 별도 확인이 필요하다.

## 8. 아직 남은 작업

### 최우선

1. DRY_RUN 장외시간 실제 엔드포인트 호출 검증
2. DRY_RUN 성공/거부/kill-switch/risk-limit 회귀 검증
3. PAPER 주문 안정성 검증

### Phase 7

- 일정 기간 PAPER 안정성 검증
- 장외/장중 경계 검증
- UNKNOWN/부분체결/취소 복구 반복 검증
- 재시작 후 상태 복구 검증

### 이후

- Strategy 인터페이스
- 진입/청산 전략
- 포지션 사이징
- 손절/익절
- 백테스트
- 자동 실행 스케줄러
- 모니터링/감사 로그
- 실계좌 매매 게이트
- 운영 안정화 및 실거래 전 체크리스트

## 9. 안전 원칙

- 실제 LIVE 주문 POST는 아직 수행하지 않는다.
- DRY_RUN 수정 때문에 LIVE/PAPER 안전장치를 약화하지 않는다.
- 실계좌 매매는 모의투자 안정성 검증 이후에만 별도 게이트를 둔다.
- Secret / 계좌번호 등 민감정보는 문서에 기록하지 않는다.
- GitHub 작업 전 최신 `main` SHA를 확인하고, 커밋 직전에도 최신 SHA를 재확인한다.
