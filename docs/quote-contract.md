# 시세 API 계약

## 엔드포인트

- `GET /quote?symbol=005930` → 단일 `StockQuote` 객체
- `GET /quotes?symbols=005930,000660` → `StockQuote[]`
- 국내주식 종목 코드는 정확히 6자리 숫자만 허용한다.
- 한 요청의 최대 종목 수는 20개다. 중복 종목은 제거한다.

## 성공 응답

```json
{
  "symbol": "005930",
  "price": 248500,
  "change": -11000,
  "changePercent": -4.24,
  "volume": 16936614,
  "asOf": "20260914 153012",
  "market": "KRX",
  "source": "KIS OPEN API",
  "delayed": false
}
```

`/quotes`는 위 객체를 배열로 반환한다.

## 오류 계약

- `400 INVALID_SYMBOLS`: 종목 코드 누락, 형식 오류, 또는 20개 초과
- `405 METHOD_NOT_ALLOWED`: GET/OPTIONS 이외의 요청
- `404 NOT_FOUND`: 지원하지 않는 경로
- `429 KIS_RATE_LIMITED`: KIS 요청 제한
- `502 KIS_UPSTREAM_ERROR` 또는 `QUOTE_UNAVAILABLE`: KIS/Proxy 오류
- `504 KIS_TIMEOUT`: KIS 응답 시간 초과

브라우저에는 KIS App Key, App Secret, Access Token 및 KIS 원문 오류를 전달하지 않는다.

## stale / missing 정책

1. 가격(`price`)이 없거나 KIS 응답이 구조적으로 유효하지 않으면 해당 시세를 성공 데이터로 취급하지 않는다.
2. `asOf`가 비어 있으면 가격은 표시할 수 있지만 **시각 미확인** 상태로 표시한다. 이를 최신 데이터로 간주하지 않는다.
3. `asOf`가 있는 경우 KST 기준 시각으로 해석한다.
4. 장중에는 마지막 체결시각이 15분보다 오래되면 `STALE`로 표시하고 자동매매 입력으로 사용하지 않는다.
5. 장 종료 후에는 마지막 정상 시세를 참고용으로 유지하되 `CLOSED` 상태로 표시한다. 다음 장 시작 후 새 시세를 확인하기 전까지 자동매매 입력으로 사용하지 않는다.
6. API 전체 실패 시 이전 정상 시세를 새 시세처럼 갱신하지 않고 `UNAVAILABLE` 상태를 표시한다.
7. stale/missing 상태는 Phase 6 Risk Manager에서 최종 주문 차단 조건으로 재사용한다.

이 정책은 **표시용 시세와 주문 판단용 시세를 분리**하기 위한 것이다. 현재 프로젝트의 Worker 기본 환경은 `PAPER`이며, 실계좌 주문과 연결되지 않는다.
