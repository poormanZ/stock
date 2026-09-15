# poormanZ/stock 프로젝트 작업 규칙

프로젝트 목표·안전 원칙·문서 체계는 [`agent.md`](./agent.md)가 기준이다. 이 문서는 코드를 고칠 때 바로 적용하는 실무 규칙만 담는다.

## 검증 명령

수정 후 보고 전에 관련 명령을 모두 실행하고 결과를 그대로 보고한다.

| 대상 | 명령 | 비고 |
|---|---|---|
| Worker 타입체크 | `cd workers/quote-api && npm run check` | vitest는 타입을 검사하지 않는다. 반드시 별도 실행 |
| Worker 테스트 | `cd workers/quote-api && npm test` | KIS 실호출 없음. `fetch`/DO는 stub |
| 프론트 타입체크·빌드 | `npm run check && npm run build` | |
| 프론트 테스트 | `npm test` | `src/` 하위만 실행 |
| KIS PAPER 통합(선택) | `cd workers/quote-api && npm run test:integration` | `KIS_INTEGRATION_APP_KEY/SECRET` 있을 때만 실행. 주문 없음 |
| Worker 번들 확인 | `cd workers/quote-api && ./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/x` | DO 바인딩·Cron 인식 확인 |
| Worker 로컬 실행 | `cd workers/quote-api && npm run dev` | `.dev.vars` 필요(`.dev.vars.example` 참고). `dev:paper`는 PAPER 환경 |

CI(`deploy-worker.yml`)는 check → test → deploy 순서로 같은 명령을 실행한다.

## 구조

```text
src/                         Vite 프론트엔드 (KIS Secret·주문 API 직접 접근 금지)
  main.ts                    진입점: 동기화·제어 동작·render·이벤트 위임(data-action/data-field)
  state.ts / api/ / format.ts / views/*.ts   상태 · Worker 클라이언트/응답 타입 · 포맷/라벨/사유 설명 · 화면 조각
workers/quote-api/src/
  index.ts                   라우트 디스패치 테이블. 핸들러는 두지 않는다
  worker.ts                  wrangler 진입점. re-export 전용
  *-routes.ts                HTTP 핸들러 (query / dry-run / paper / live / risk / audit / strategy / trading)
  env.ts                     Env 타입, 어댑터 팩토리, DO stub 접근
  http.ts                    json / noContent / withCors / errorResponse
  state-clients.ts           내부 상태·DRY_RUN·Kill Switch DO 호출
  kis-*.ts                   KIS 어댑터·HTTP 클라이언트·토큰·공통 유틸
  order-domain.ts            Order 상태 머신 (모든 상태 변경의 단일 진입점)
  risk-manager.ts            checkRisk + Kill Switch/실계좌 arm DO
  position-ledger.ts         체결 증분 → 포지션·당일 실현손익 (순수)
  daily-loss.ts              KIS 기간별매매손익(LIVE) 집계 (순수)
  strategy.ts / backtest.ts  전략 인터페이스·SMA 전략·사이징·손절익절 / 백테스트 (순수)
  trading-state.ts           자동매매 상태 DO (설정·lease·실행 이력)
  trading-engine.ts          Cron 사이클. TradingDeps 주입으로 테스트
  live-trading-gate.ts       실계좌 게이트 (순수). live-routes.ts만 사용
  audit-log.ts / alerts.ts   감사 이벤트 DO / webhook 알림
integration/                 실제 KIS PAPER 읽기 전용 통합 테스트 (환경변수 있을 때만)
```

## 코딩 규칙

- **주문 상태는 `transitionOrder`로만 바꾼다.** `status`를 직접 대입하지 않는다.
- **주문 요청은 `isValidOrderRequest` / `assertOrderRequest`를 거친 뒤에만 사용한다.** 라우트에서 `as CreateOrderRequest` 캐스팅으로 검증을 우회하지 않는다.
- **KIS 호출은 `env.ts`의 `create*Adapter(env)`로 만든다.** 라우트에서 `KISHttpClient`를 직접 생성하지 않는다.
- **DO 응답을 브라우저로 전달할 때는 `withCors(response, origin)`을 거친다.** 직접 JSON을 만들 때는 `json()`. 204 응답은 `noContent()`만 사용한다(204에 body를 넣으면 런타임 오류).
- **KIS 조회 응답은 `assertAccepted(operation, data)`로 검사한다.** `rt_cd`가 정확히 `'0'`일 때만 성공이다.
- **주문 POST는 5xx에서 재시도하지 않는다.** 전송 결과가 불확실하면 `UNKNOWN`으로 기록하고 `/paper/reconcile`에 맡긴다. `KISHttpClient.request`의 재시도 조건을 넓히지 않는다.
- **시각 처리**: KST 날짜는 `toKstDate`/`todayKst`, KIS 시각 문자열은 `kisTimestampToIso`, 토큰 만료는 `toTokenExpiry`를 사용한다. `new Date(kisString)`을 직접 쓰지 않는다.
- **오류 매핑**: 어댑터는 `KISHttpError` / `KISRejectedError` / `KISAccountConfigError`를 던지고, 라우트는 `errorResponse(error, origin, scope)`로 변환한다. 메시지 문자열을 정규식으로 파싱해 분기하지 않는다.
- **PAPER/LIVE 안전장치(환경 검사, 계좌 검사, 장 운영시간, reconciliation Gate, Risk Manager, Kill Switch)는 DRY_RUN 편의를 위해 약화하지 않는다.** DRY_RUN은 KIS 외부 조회 없이 Risk Manager와 Kill Switch만 적용한다.
- **라우트를 추가하면** `index.ts` 테이블에 등록하고 `index.test.ts`에 최소 1개 케이스(성공 또는 검증 실패)를 추가한다.
- **전략은 순수 함수로만 작성한다.** `strategy.ts`에서 KIS·DO·fetch를 import하지 않는다. 새 전략은 `STRATEGIES`에 등록하고 결정적 캔들로 테스트한다.
- **엔진(`trading-engine.ts`)은 `TradingDeps`를 통해서만 외부와 통신한다.** 새 외부 의존이 필요하면 deps에 추가하고 `createDefaultDeps`와 테스트 stub을 함께 갱신한다. 스케줄러에 LIVE 모드를 추가하지 않는다.
- **실계좌 경로는 `checkLiveTradingGate`를 우회하지 않는다.** `LIVE_TRADING_ENABLED`/`PAPER_VERIFICATION_DATE`를 `wrangler.toml` `[vars]`에 넣지 않는다. `KISLiveOrderAdapter`는 `live-routes.ts` 밖에서 생성하지 않는다.
- **취소 접수는 `CANCEL_PENDING`으로 기록한다.** `CANCELED`는 resync가 KIS 내역으로 확정할 때만 쓴다.
- **주문·Risk·reconciliation·긴급정지에 영향을 주는 코드에는 `appendAudit`를 남긴다.** 감사 기록 실패가 주문을 막으면 안 되므로 `appendAudit` 밖에서 새로 throw하지 않는다.
- **새 Durable Object 클래스**는 `worker.ts` export, `wrangler.toml` 바인딩 + 새 `[[migrations]]` 태그, `env.ts` `Env`/`StateStoreBinding`, `index.test.ts`의 `makeEnv` stub을 함께 갱신한다.
- **로그에 `APP_KEY`/`APP_SECRET`/토큰/전체 계좌번호를 남기지 않는다.** 외부 오류 메시지는 `redactSensitiveText`를 거친다.
- 프론트엔드 API 응답 타입은 `src/api/types.ts` 한 곳에서 Worker의 실제 응답 필드명과 맞춘다. Worker 응답 필드를 바꾸면 이 파일을 함께 고친다.
- 프론트 뷰는 HTML 문자열을 반환하는 순수 함수(`views/*.ts`)로 작성하고, 모든 동적 텍스트는 `esc()`를 거친다. 버튼은 `data-action`, 입력은 `data-field`로 `main.ts`의 위임 리스너에 연결한다. 뷰 안에서 `addEventListener`를 붙이지 않는다.
- 상태 코드·사유 코드를 화면에 그대로 내보내지 않고 `format.ts`의 라벨/`describeReason`을 거친다. 새 사유 코드를 엔진에 추가하면 `describeReason`에도 설명을 추가한다.
- 주문에 `reason`을 넣는다. 자동매매는 신호 사유, 수동 주문은 `manual`. 200자 이내.

## 테스트 작성 규칙

- 환경은 `node`. KIS 응답은 `KISJsonResponse` 형태의 stub, DO는 `{ idFromName, get: () => ({ fetch }) }` stub을 쓴다(`index.test.ts` 참고).
- `KISHttpClient`는 모듈 전역 상태(토큰 캐시, 요청 간격)를 공유하므로 테스트마다 `baseUrl`을 다르게 주고, fake timer는 `toFake: ['setTimeout', 'clearTimeout']`로 제한한다.
- 상태 머신 위반, 부분체결, UNKNOWN 복구, 중복 주문처럼 돈이 걸린 경로는 실패 케이스를 먼저 쓴다.

## 문서 갱신

- 기능·엔드포인트·응답 필드를 바꾸면 `docs/design.md`(구조·계약)와 `docs/status.md`(현재 상태)를 같은 변경에서 갱신한다.
- `docs/roadmap.md`의 체크는 코드와 테스트가 실제로 있을 때만 바꾼다.
- 시세 응답 필드를 바꾸면 `docs/quote-contract.md`를 갱신한다.
