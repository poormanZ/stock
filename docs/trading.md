# 전략 · 주문 · 리스크 규칙

> 기준일: 2026-09-15

## 1. 전략 인터페이스

`workers/quote-api/src/strategy.ts`

```text
Strategy { id, params, warmupBars, evaluate(context) → Signal }
StrategyContext { symbol, candles(오래된 순, 마지막이 판단 봉), position | null }
Signal { action: 'buy' | 'sell' | 'hold', reason }
```

- 전략은 순수 함수다. KIS 호출, 상태 저장, 주문 전송을 하지 않는다.
- 백테스트(`backtest.ts`)와 자동 실행(`trading-engine.ts`)이 같은 `evaluate`를 호출한다.
- 전략 등록: `strategy.ts`의 `STRATEGIES`에 팩토리를 추가하면 `GET /strategies`, `/backtest`, `/trading/configure`에서 사용할 수 있다.

## 2. 구현된 전략

### sma-crossover

| 항목 | 값 |
|---|---|
| 파라미터 | `fast`(기본 5), `slow`(기본 20), `fast < slow` |
| 진입 | 단기 SMA가 장기 SMA를 상향 돌파하고 보유 포지션이 없을 때 매수 |
| 청산 | 단기 SMA가 장기 SMA를 하향 돌파하고 보유 포지션이 있을 때 매도 |
| 워밍업 | `slow + 1` 봉 |

## 3. 손절 / 익절 (`checkExitRules`)

전략 신호보다 먼저 평가한다. 보유 포지션 평균단가 대비 현재가 변동률(%)로 판단한다.

| 규칙 | 기본값 | 0이면 |
|---|---|---|
| `stopLossPct` | 5 | 사용 안 함 |
| `takeProfitPct` | 10 | 사용 안 함 |

## 4. 포지션 사이징 (`sizeEntry`)

진입 수량 = min(현금 × `cashFraction` ÷ 유효가, `maxOrderAmount` ÷ 가격, `maxOrderQuantity`, `maxPositionQuantity` − 보유수량)을 정수로 내림. 유효가는 가격 × (1 + 슬리피지 + 수수료)다.

| 규칙 | 기본값 |
|---|---|
| `cashFraction` | 0.2 |
| `maxOrderAmount` | 1,000,000원 |
| `maxOrderQuantity` | 1,000주 |
| `maxPositionQuantity` | 5,000주 |

매도는 항상 보유 수량 전체다.

## 5. 백테스트 (`POST /backtest`)

- 봉 i 종가에서 신호를 내고 봉 i+1 시가에 시장가로 체결한다(미래 참조 방지).
- 체결·수수료(15bp)·거래세(매도 20bp)·슬리피지(5bp)는 DRY_RUN 시뮬레이터(`simulateOrder`)를 그대로 사용한다.
- 지표: 총수익률, 거래 수, 승률, 손익비(총이익/총손실), 최대낙폭, 총수수료·세금. 미청산 포지션은 마지막 종가로 평가한다.
- 최대 범위 1,000일. 결과는 시뮬레이션이며 실거래 성과를 보장하지 않는다(응답에 `disclaimer` 포함).

## 6. 주문 규칙

| 항목 | 규칙 |
|---|---|
| 요청 검증 | `id`, `clientOrderId`, 6자리 `symbol`, `side ∈ buy/sell`, `orderType ∈ market/limit`, 정수 `quantity > 0`, limit은 `limitPrice > 0`, market은 `limitPrice` 금지, `reason`은 선택(≤200자) |
| 주문 사유 | 자동매매는 신호 사유(`SMA5>SMA20`, `STOP_LOSS:-5.20%`, `TAKE_PROFIT:+10.10%`)를, 대시보드 수동 주문은 `manual`을 `reason`에 넣는다. 주문 기록·감사 로그·실행 이력에 남고 KIS로는 전송하지 않는다 |
| 상태 변경 | `transitionOrder`만 사용. 허용 전이는 `docs/design.md` §7 |
| 멱등성 | 같은 `clientOrderId`는 기존 주문을 반환한다(DRY_RUN·PAPER·LIVE). 자동매매는 `AUTO-{mode}-{날짜}-{종목}-{방향}` |
| 재시도 | 주문 POST는 KIS 5xx에 재시도하지 않는다. 429만 재시도. 결과 불확실 시 `UNKNOWN` |
| 취소 | `SUBMITTED/ACCEPTED/PARTIALLY_FILLED`만 취소 가능. 접수 응답으로 `CANCELED` 기록, 이후 resync로 대조 |
| DRY_RUN | KIS 계좌·시세·장시간에 의존하지 않는다. `referencePrice` 사용 |
| PAPER | 정규장(KST 09:00~15:30 평일)만. reconciliation Gate·실시간 시세 필수 |
| LIVE | `docs/operations.md` §8 게이트 통과 시에만. 스케줄러 미지원 |

## 7. Risk Manager (`checkRisk`)

검사 순서(하나라도 실패하면 차단):

1. Kill Switch
2. reconciliation 불일치(PAPER/LIVE)
3. API 장애 플래그
4. 기준가 유효성
5. 시세 나이 ≤ `maxQuoteAgeMs`(15초). 기준 시각은 KIS 체결시각, 없으면 수신 시각
6. `maxOrderQuantity` 1,000주
7. `maxOrderAmount` 1,000,000원(지정가는 지정가×수량, 시장가는 기준가×수량)
8. `maxPositionQuantity` 5,000주, 매도 후 음수 금지
9. `maxDailyOrders` 20건(KST 당일 주문 기록 수)
10. `maxDailyLoss` 100,000원(당일 실현손실. DRY_RUN은 시뮬레이터, PAPER/LIVE는 체결 증분 원장)

한도는 `DEFAULT_RISK_CONFIG`에 고정되어 있다. 계좌 규모에 맞게 바꾸려면 코드 수정과 테스트 갱신이 필요하다.

## 8. 포지션 원장과 실현손익

- 내부 포지션은 주문 기록의 체결 증분(`executedQuantity` 차이)으로만 갱신한다(`position-ledger.ts`). 같은 기록을 다시 적용해도 변화가 없다.
- 기준선은 `POST /paper/position-sync`로 KIS 스냅샷을 채택해 만든다.
- 매도 체결 시 (체결가 − 평균단가) × 수량을 KST 당일 실현손익에 더한다. 날짜가 바뀌면 0부터 시작한다.
- DRY_RUN은 수수료·세금까지 뺀 값을 실현손익으로 기록한다.
