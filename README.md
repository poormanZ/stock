# 한국투자증권 자동 주식매매 시스템

`poormanZ/stock`은 한국투자증권(KIS) Open API를 기반으로 하는 웹 주식 대시보드 및 자동매매 시스템이다.

## 개발 방향

```text
시장 데이터
   ↓
전략 엔진
   ↓
위험관리(Risk Manager)
   ↓
주문 관리(Order Manager)
   ↓
KIS Open API
   ↓
체결/잔고/포지션 대조
```

실제 매매는 다음 순서로 단계적으로 검증한다.

`DRY_RUN → KIS 모의투자 → 실계좌`

실계좌 주문은 기본적으로 비활성화하며, 명시적인 활성화와 위험관리 검증을 모두 통과해야 한다.

## 현재 구현

- Vite + TypeScript 기반 웹 대시보드
- 관심종목 관리 및 샘플 시세
- Cloudflare Worker 기반 KIS 시세 Proxy
- `/quote`, `/quotes` 국내주식 시세 조회
- KIS Access Token 캐시
- 시세 freshness 정책: `FRESH / STALE / TIME UNKNOWN / CLOSED`
- GitHub Pages 자동 빌드/배포 구성
- 자동매매 아키텍처 및 단계별 로드맵 문서화

현재는 **시세 조회 및 자동매매 기반 설계 단계**이며 실계좌 자동매매가 구현되거나 활성화된 상태가 아니다.

## 문서

- [`agent.md`](./agent.md) — AI/개발 및 자동매매 안전 지침
- [`docs/roadmap.md`](./docs/roadmap.md) — 단계별 개발 로드맵
- [`docs/design.md`](./docs/design.md) — 시스템 아키텍처 및 데이터/주문 설계
- [`docs/api-strategy.md`](./docs/api-strategy.md) — KIS API 선정 및 연동 기록
- [`docs/quote-contract.md`](./docs/quote-contract.md) — 시세 API 계약 및 freshness 정책

## 보안

KIS App Key, App Secret, Access Token, 계좌번호 등 민감정보는 소스 코드와 GitHub 저장소에 저장하지 않는다. 서버 측 Secret으로만 주입하며 브라우저에 노출하지 않는다.

브라우저는 공개된 Worker URL만 사용하며 KIS 인증정보를 직접 보유하거나 KIS 주문 API를 호출하지 않는다.

## 다음 단계

현재 로드맵은 **Phase 2 — 시세 서비스 안정화**를 진행 중이다.

1. GitHub Actions에서 Pages 빌드/배포 성공 검증
2. 실제 Pages에서 KIS Worker 시세 표시 검증
3. Phase 2 완료 판정
4. 계좌/잔고 읽기 전용 모델로 진행
