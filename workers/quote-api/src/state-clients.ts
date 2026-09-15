import { isAuditEventInput, type AuditEventInput } from './audit-log';
import type { DryRunState } from './dry-run-simulator';
import { type Env, getPrimaryStore } from './env';
import type { InternalState } from './internal-state-store';
import type { ReconciliationPosition } from './reconciliation';
import type { Order } from './order-domain';
import type { KillSwitchState, RiskStateSnapshot } from './risk-manager';
import type { TradingCommand, TradingRun, TradingState, TradingStatus } from './trading-state';

export const INTERNAL_STATE_UNAVAILABLE = 'INTERNAL_STATE_UNAVAILABLE';
const INTERNAL_STATE_URL = 'https://internal-state/';
const DRY_RUN_STATE_URL = 'https://dry-run-state/';
const RISK_STATE_URL = 'https://risk-state/';
const AUDIT_LOG_URL = 'https://audit-log/';
const TRADING_STATE_URL = 'https://trading-state/';
const JSON_HEADERS = { 'content-type': 'application/json' };

async function readJson<T>(stub: DurableObjectStub, url: string, unavailable: string): Promise<T> {
  const response = await stub.fetch(url);
  if (!response.ok) throw new Error(unavailable);
  return (await response.json()) as T;
}

function postJson(stub: DurableObjectStub, url: string, body: unknown): Promise<Response> {
  return stub.fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function readInternalState(env: Env): Promise<InternalState> {
  return readJson<InternalState>(getPrimaryStore(env, 'INTERNAL_STATE_STORE'), INTERNAL_STATE_URL, INTERNAL_STATE_UNAVAILABLE);
}

export async function applyInternalOrder(env: Env, order: Order): Promise<void> {
  const response = await postJson(getPrimaryStore(env, 'INTERNAL_STATE_STORE'), INTERNAL_STATE_URL, { action: 'apply-order', order });
  if (!response.ok) throw new Error(INTERNAL_STATE_UNAVAILABLE);
}

export async function syncInternalPositions(env: Env, positions: ReconciliationPosition[]): Promise<InternalState> {
  const response = await postJson(getPrimaryStore(env, 'INTERNAL_STATE_STORE'), INTERNAL_STATE_URL, { action: 'sync-positions', positions });
  if (!response.ok) throw new Error(INTERNAL_STATE_UNAVAILABLE);
  return (await response.json()) as InternalState;
}

/** 감사 이벤트 기록. 기록 실패가 주문 처리 자체를 막지 않도록 오류를 흡수한다 */
export async function appendAudit(env: Env, event: AuditEventInput): Promise<void> {
  if (!isAuditEventInput(event)) return;
  try {
    const response = await postJson(getPrimaryStore(env, 'AUDIT_LOG_STORE'), AUDIT_LOG_URL, event);
    if (!response.ok) console.error('audit append rejected', { status: response.status, type: event.type });
  } catch (error) {
    console.error('audit append failed', { type: event.type, message: error instanceof Error ? error.message : 'unknown error' });
  }
}

export function fetchAuditLog(env: Env, params: URLSearchParams): Promise<Response> {
  return getPrimaryStore(env, 'AUDIT_LOG_STORE').fetch(`${AUDIT_LOG_URL}?${params}`);
}

export function fetchDryRunState(env: Env): Promise<Response> {
  return getPrimaryStore(env, 'DRY_RUN_STATE_STORE').fetch(DRY_RUN_STATE_URL);
}

export function readDryRunState(env: Env): Promise<DryRunState> {
  return readJson<DryRunState>(getPrimaryStore(env, 'DRY_RUN_STATE_STORE'), DRY_RUN_STATE_URL, 'DRY_RUN_STATE_UNAVAILABLE');
}

export function postDryRunCommand(env: Env, body: unknown): Promise<Response> {
  return postJson(getPrimaryStore(env, 'DRY_RUN_STATE_STORE'), DRY_RUN_STATE_URL, body);
}

export function fetchKillSwitch(env: Env): Promise<Response> {
  return getPrimaryStore(env, 'RISK_STATE_STORE').fetch(RISK_STATE_URL);
}

export function readKillSwitch(env: Env): Promise<KillSwitchState> {
  return readJson<KillSwitchState>(getPrimaryStore(env, 'RISK_STATE_STORE'), RISK_STATE_URL, 'RISK_STATE_UNAVAILABLE');
}

export function readRiskState(env: Env): Promise<RiskStateSnapshot> {
  return readJson<RiskStateSnapshot>(getPrimaryStore(env, 'RISK_STATE_STORE'), RISK_STATE_URL, 'RISK_STATE_UNAVAILABLE');
}

export function postKillSwitchCommand(env: Env, body: unknown): Promise<Response> {
  return postJson(getPrimaryStore(env, 'RISK_STATE_STORE'), RISK_STATE_URL, body);
}

export function fetchTradingState(env: Env): Promise<Response> {
  return getPrimaryStore(env, 'TRADING_STATE_STORE').fetch(TRADING_STATE_URL);
}

export function readTradingState(env: Env): Promise<TradingState> {
  return readJson<TradingState>(getPrimaryStore(env, 'TRADING_STATE_STORE'), TRADING_STATE_URL, 'TRADING_STATE_UNAVAILABLE');
}

export function postTradingCommand(env: Env, command: TradingCommand): Promise<Response> {
  return postJson(getPrimaryStore(env, 'TRADING_STATE_STORE'), TRADING_STATE_URL, command);
}

export async function acquireTradingLease(env: Env, runId: string, ttlMs: number): Promise<boolean> {
  const response = await postTradingCommand(env, { action: 'acquire-lease', runId, ttlMs });
  if (!response.ok) throw new Error('TRADING_STATE_UNAVAILABLE');
  return ((await response.json()) as { acquired: boolean }).acquired;
}

export async function releaseTradingLease(env: Env, runId: string): Promise<void> {
  await postTradingCommand(env, { action: 'release-lease', runId });
}

export async function recordTradingRun(env: Env, run: TradingRun, nextStatus?: TradingStatus, error?: string): Promise<void> {
  const response = await postTradingCommand(env, { action: 'record-run', run, nextStatus, error });
  if (!response.ok) throw new Error('TRADING_STATE_UNAVAILABLE');
}
