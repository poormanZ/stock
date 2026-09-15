# 운영 매뉴얼

> 기준일: 2026-09-15

## 1. 구성 요소

| 구성 | 위치 | 역할 |
|---|---|---|
| GitHub Pages 프론트 | `src/` → `https://poormanz.github.io` | 시세·계좌·DRY_RUN·자동매매 상태 조회, DRY_RUN 주문, Kill Switch |
| Cloudflare Worker | `workers/quote-api/` → `stock-quote-api` | 모든 KIS 통신, 주문 경로, 상태 저장 |
| KV `KIS_TOKEN_CACHE` | Cloudflare | KIS Access Token 캐시(`{accessToken, expiresAt}`) |
| DO `KISTokenBroker` | Cloudflare | 토큰 발급 단일화(1분 1회 제한 보호) |
| DO `InternalStateStoreDO` | Cloudflare | 주문 기록, 포지션 원장, 당일 실현손익 |
| DO `DryRunStateStoreDO` | Cloudflare | DRY_RUN 가상 계좌 |
| DO `RiskStateStoreDO` | Cloudflare | Kill Switch, 실계좌 arm 상태 |
| DO `AuditLogStoreDO` | Cloudflare | 감사 이벤트 500건 순환 |
| DO `TradingStateStoreDO` | Cloudflare | 자동매매 상태·설정·실행 이력·lease |
| Cron Trigger | `wrangler.toml` | `*/5 0-6 * * 1-5` (KST 09:00~15:59 평일 5분) |

## 2. 환경변수 / Secret

| 이름 | 종류 | 기본 | 설명 |
|---|---|---|---|
| `APP_KEY`, `APP_SECRET` | Secret | 필수 | KIS App Key/Secret. 환경(LIVE/PAPER)과 일치해야 한다 |
| `ACCOUNT_CANO` | Secret | 필수 | 계좌번호 앞 8자리 |
| `ACCOUNT_PRODUCT_CODE` | Secret | `01` | 국내주식 위탁계좌 상품코드 |
| `KIS_ENVIRONMENT` | var | `LIVE` | `LIVE`(조회 전용 운영) / `PAPER`(모의투자 주문 검증) |
| `ALLOWED_ORIGIN` | var | Pages 도메인 | CORS 허용 origin |
| `KIS_BASE_URL` | var | 없음 | KIS 도메인 override(테스트용) |
| `ALERT_WEBHOOK_URL` | Secret | 없음 | UNKNOWN 주문·긴급정지·시스템 오류 알림 webhook(JSON, Slack 호환 `text`) |
| `LIVE_TRADING_ENABLED` | Secret/var | **없음** | 정확히 `true`일 때만 `/live/*` 주문 경로가 열린다. `wrangler.toml`에 두지 않는다 |
| `PAPER_VERIFICATION_DATE` | Secret/var | **없음** | 모의투자 안정성 검증 완료일(YYYYMMDD). 없으면 실계좌 주문 불가 |

Secret은 GitHub Actions Secrets → `deploy-worker.yml` → `wrangler secret`으로 주입한다. 값을 문서·코드·로그에 기록하지 않는다.

## 3. 배포

- `main`에 `workers/quote-api/**` 변경이 push되면 `deploy-worker.yml`이 `check → test → deploy`를 실행한다.
- 새 Durable Object 클래스를 추가하면 `wrangler.toml`에 바인딩과 `[[migrations]]` 태그를 함께 추가한다. 태그는 append-only다.
- 배포 후 확인:

```bash
W=https://stock-quote-api.darkq4.workers.dev
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS -H 'Origin: https://poormanz.github.io' -H 'Access-Control-Request-Method: POST' $W/dry-run/orders   # 204
curl -s -D - $W/risk | grep -i access-control-allow-origin   # Pages 도메인
curl -s $W/trading/status | head -c 200                       # {"status":"STOPPED",...}
curl -s $W/live/status                                        # "reason":"LIVE_TRADING_DISABLED"
```

## 4. 로컬 실행

```bash
cd workers/quote-api && cp .dev.vars.example .dev.vars   # 값 입력
npm run dev            # LIVE 키, http://localhost:8787
npm run dev:paper      # PAPER 키, KIS_ENVIRONMENT=PAPER
# 루트에서
echo 'VITE_QUOTE_API_BASE_URL=http://localhost:8787' > .env.local && npm run dev
```

로컬 DO/KV는 `.wrangler/state/`에 저장되며 운영과 분리된다. Cron은 `npm run dev -- --test-scheduled` 후 `curl http://localhost:8787/__scheduled`로 수동 트리거할 수 있다.

## 5. 자동매매 운영

상태 전이:

```text
STOPPED ─configure→ READY ─start→ RUNNING ─stop→ STOPPED
RUNNING ─(사이클 오류)→ ERROR ─start→ RUNNING
RUNNING ─(Kill Switch)→ EMERGENCY_STOP ─(Kill Switch 해제 후 start)→ RUNNING
```

| 작업 | 호출 |
|---|---|
| 설정 | `POST /trading/configure {config}` — `mode`(DRY_RUN/PAPER), `symbols`(≤10), `strategy {id, params}`, `exit`, `sizing`, `candleBars` |
| 시작 / 정지 | `POST /trading/start` / `POST /trading/stop` |
| 수동 1회 실행 | `POST /trading/run` (cron과 동일 경로, lease 적용) |
| 상태 / 이력 | `GET /trading/status`, `GET /trading/runs?limit=` |

실행 규칙:

- 사이클마다 lease(120초)를 잡는다. 이전 실행이 살아 있으면 건너뛴다(중복 실행 방지). 실행이 비정상 종료돼도 lease는 만료로 풀린다(장애 후 재개).
- PAPER 모드는 정규장에만 주문하며, 매 사이클 시작 시 `/paper/reconcile`과 같은 resync를 먼저 수행해 UNKNOWN 주문을 복구한다. DRY_RUN은 장 운영시간과 무관하게 동작한다.
- 주문 `clientOrderId`는 `AUTO-{mode}-{YYYYMMDD}-{symbol}-{BUY|SELL}`로 고정되어 하루에 종목·방향별 한 번만 진입/청산한다.
- 데이터·전략·주문 오류는 첫 오류에서 사이클을 중단하고 상태를 `ERROR`로 바꾼다. 원인을 감사 로그(`GET /audit`)에서 확인한 뒤 `start`로 재개한다.
- 스케줄러는 LIVE 모드를 지원하지 않는다.

## 6. 장애 대응

| 증상 | 확인 | 조치 |
|---|---|---|
| `KIS_AUTH_FAILED` 반복 | `/audit?type=SYSTEM_ERROR`, KIS 포털 키 상태 | App Key 만료/환경 불일치 확인. 토큰은 401/403 시 1회 자동 재발급 |
| `KIS_RATE_LIMITED` | 호출 빈도 | PAPER는 1.1초 간격 강제. 프론트 SYNC 남발 여부 확인 |
| 주문 `*_ORDER_UNKNOWN` | `/audit?type=ORDER_UNKNOWN`, webhook 알림 | `POST /paper/reconcile`로 KIS 당일 내역과 대조. `unresolved`에 남으면 KIS HTS/MTS에서 수동 확인 |
| `/reconciliation` 항상 `MISMATCHED` | `differences` | 내부 포지션 기준선이 없으면 `POST /paper/position-sync`(PAPER)로 KIS 스냅샷 채택 후 체결 증분으로 추적 |
| 엔진 `ERROR` | `GET /trading/status` `error`, `GET /trading/runs` | 원인 제거 후 `POST /trading/start` |
| 엔진 `EMERGENCY_STOP` | Kill Switch 사유 | 사유 해소 → `POST /risk/kill-switch {action:'deactivate'}` → `start` |

## 7. 긴급 정지

```bash
curl -X POST $W/risk/kill-switch -H 'content-type: application/json' -d '{"action":"activate","reason":"manual stop"}'
```

- 모든 신규 주문(DRY_RUN/PAPER/LIVE)이 즉시 차단되고 엔진은 다음 사이클에 `EMERGENCY_STOP`으로 전이한다.
- 실계좌 arm 상태도 함께 해제된다.
- `ALERT_WEBHOOK_URL`이 있으면 CRITICAL 알림이 전송된다.
- 이미 KIS에 접수된 주문은 취소되지 않는다. 필요하면 `/paper/orders/cancel` 또는 KIS HTS/MTS에서 취소한다.

## 8. 실계좌(LIVE) 주문 활성화 절차와 체크리스트

기본 상태에서는 `/live/orders`가 `403 LIVE_TRADING_DISABLED`를 반환하며 어떤 KIS 호출도 하지 않는다. 다음을 **모두** 만족하기 전에는 활성화하지 않는다.

- [ ] Phase 7 PAPER 안정성 검증을 최소 4주 이상 수행하고 성공/거부/UNKNOWN/부분체결/취소/재시작 복구를 각각 1회 이상 확인했다
- [ ] `/paper/reconcile` 결과에 `unresolved`가 남지 않는 상태를 연속 5거래일 확인했다
- [ ] `/reconciliation`이 거래일 마감 기준 `MATCHED`인 것을 연속 5거래일 확인했다
- [ ] 일일 손실 한도(`maxDailyLoss`)와 주문 한도(`DEFAULT_RISK_CONFIG`)를 실계좌 자금 규모에 맞게 검토했다
- [ ] `ALERT_WEBHOOK_URL`이 설정되어 UNKNOWN/긴급정지 알림이 실제로 수신되는 것을 확인했다
- [ ] Kill Switch 활성화 → 주문 차단 → 해제 흐름을 PAPER에서 리허설했다
- [ ] LIVE App Key가 실계좌용이고 `ACCOUNT_CANO`가 의도한 계좌인지 KIS 포털에서 확인했다
- [ ] 운영자 2인이 이 체크리스트를 검토했다

활성화 순서:

1. Secret에 `PAPER_VERIFICATION_DATE=YYYYMMDD`(검증 완료일)와 `LIVE_TRADING_ENABLED=true`를 넣고 재배포한다. `wrangler.toml`에는 넣지 않는다.
2. `GET /live/status`로 `checks`를 확인한다. `enabled`, `paperVerified`, `liveEnvironment`, `accountConfigured`가 true여야 한다.
3. 주문 직전 `POST /live/arm {"confirmation":"I_UNDERSTAND_LIVE_TRADING","ttlSeconds":300,"reason":"..."}`로 최대 15분 동안 arm 한다.
4. `POST /live/orders {"request":{...},"referencePrice":...,"confirmation":"I_UNDERSTAND_LIVE_TRADING"}`. 게이트는 정규장·Kill Switch·reconciliation Gate·Risk Manager를 모두 다시 검사한다.
5. 작업이 끝나면 `POST /live/disarm`. 비활성화는 `LIVE_TRADING_ENABLED` Secret 삭제 후 재배포다.

스케줄러는 LIVE를 지원하지 않으므로 실계좌 주문은 항상 운영자의 수동 호출이다.
