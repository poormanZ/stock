# 현재 개발 상태

> 기준일: 2026-09-15
> 기준 브랜치: `main`
> 정리 기준 커밋: `b80a185` (`docs: record PAPER position sync status`)

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
- PAPER 명시적 포지션 스냅샷 동기화 `/paper/position-sync`
- LIVE KST 거래일 실현손익 Adapter 1차 구현 (`TTTC8715R`)

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
- KIS reconciliation과 완전 분리
- 장외시간/주말 실측 검증 완료
- 동일 `clientOrderId` 멱등성 실측 완료

### PAPER

- PAPER 주문 Adapter
- reconciliation Gate
- Risk Manager
- `clientOrderId` 멱등성
- UNKNOWN 상태 처리
- 주문/체결 조회
- 부분체결/취소 복구
- 장 운영시간 처리
- **KIS 계좌 보유수량 → 내부 포지션 명시적 동기화**
- 손익 데이터 미지원 환경에서는 `DAILY_LOSS_UNAVAILABLE`로 fail-closed 할 수 있는 Risk Manager 방어 로직

현재 Worker 자체가 `LIVE` 환경이므로 PAPER 주문/동기화 경로를 실제 운영 Worker에서 수행하지 않는다.

## 4. 포지션 동기화 정책

내부 포지션은 자동 주문 경로에서 KIS 값으로 조용히 덮어쓰지 않는다. 운영자가 명시적으로 `POST /paper/position-sync`를 호출하면 KIS `AccountSnapshot.positions`의 `symbol`과 `quantity`를 내부 Durable Object 포지션에 반영한다.

- 기존 `orderRecords`와 주문 요약은 보존한다.
- 체결 기록을 근거 없이 역산해 포지션을 추정하지 않는다.
- 외부에서 발생한 예상치 못한 포지션 변경은 자동 주문 시 reconciliation mismatch로 감지되며 fail-closed 한다.
- 동기화 후에도 주문 상태가 KIS와 다르면 신규주문 Gate는 열린 상태로 바뀌지 않는다.
- DRY_RUN은 별도 가상 상태를 사용하므로 이 동기화 경로의 대상이 아니다.

## 5. 위험관리 상태

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
- 손익 데이터 미확인 시 신규주문 fail-closed (`DAILY_LOSS_UNAVAILABLE`)

`dailyLoss` 계산 순수 로직과 LIVE `TTTC8715R` Adapter 1차 구현이 완료되었다. 다만 현재 PAPER 환경에서는 KIS 공식 샘플에서 해당 기간별매매손익 API의 PAPER TR ID를 확인하지 못했으므로 추측한 `VTTC*` TR을 사용하지 않는다.

## 6. LIVE / PAPER / DRY_RUN 역할 구분

| 영역 | 목적 | KIS 외부 주문 | 장시간 의존 |
|---|---|---:|---:|
| DRY_RUN | 로컬/가상 주문 검증 | 없음 | 없음 |
| PAPER | KIS 모의투자 주문 검증 | 있음 | 있음 |
| LIVE | 실제 계좌 조회/운영 기반 | 현재 주문 미구현 | 실제 운영 규칙 적용 |

핵심 원칙은 **DRY_RUN을 KIS와 분리하고, PAPER/LIVE의 안전장치를 약화시키지 않는 것**이다.

## 7. 최근 변경 이력

### `b80a185` — 2026-09-15 PAPER 포지션 동기화 상태 기록

- 명시적 포지션 동기화 1차 구현 상태 기록

### `c4e2db4` — 2026-09-15 DRY_RUN 배포 후 실측 완료

- CORS preflight 정상 동작 확인
- `/risk`, `/dry-run` CORS 헤더 확인
- GitHub Pages 장외시간 DRY_RUN 주문 성공 확인
- `clientOrderId` 멱등성 확인
- Kill Switch 차단 확인

### `96b0a0e` — 2026-09-15 버그 수정 / 리팩토링

- CORS preflight, PAPER 위험검사, token expiry, 주문 재시도/UNKNOWN 처리, 라우터 분리, Worker 타입체크 등을 수정했다.

## 8. 검증 상태

기존 로컬 검증(`96b0a0e` 기준):

| 항목 | 결과 |
|---|---|
| Worker `npm run check` | 통과 |
| Worker `npm test` | 17 파일 / 86 테스트 통과 |
| 프론트 `npm run check` / `npm run build` | 통과 |

이번 변경으로 daily-loss 순수 테스트와 Risk Manager fail-closed 테스트가 추가되었으므로 최신 `main`에서 CI/로컬 검증을 다시 통과시켜야 한다.

## 9. 아직 남은 작업

### 최우선

1. PAPER 주문 경로에 검증된 dailyLoss 공급 연결
2. 최신 변경 기준 Worker check/test 재검증
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

## 10. 알려진 한계

- KIS 공식 샘플에서 확인되는 `TTTC8715R` 기간별매매손익 API는 LIVE용으로 확인되며 PAPER용 TR ID는 확인하지 않았다.
- 따라서 PAPER에서는 손익 조회를 추측하지 않고 fail-closed 해야 한다.
- PAPER 취소는 접수 응답만으로 `CANCELED` 처리하며, 취소 전 체결 경합은 자동 복구되지 않는다.
- `market-session.ts`는 KRX 휴장일을 반영하지 않는다.
- 최신 코드의 전체 check/test 결과는 다음 검증에서 다시 확인한다.

## 11. 안전 원칙

- 실제 LIVE 주문 POST는 아직 수행하지 않는다.
- DRY_RUN 수정 때문에 LIVE/PAPER 안전장치를 약화하지 않는다.
- 실계좌 매매는 모의투자 안정성 검증 이후에만 별도 게이트를 둔다.
- Secret / 계좌번호 등 민감정보는 문서에 기록하지 않는다.
- GitHub 작업 전 최신 `main` SHA를 확인하고, 커밋 직전에도 최신 SHA를 재확인한다.
