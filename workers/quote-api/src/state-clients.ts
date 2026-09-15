import type { DryRunState } from './dry-run-simulator';
import { type Env, getPrimaryStore } from './env';
import type { InternalState } from './internal-state-store';
import type { Order } from './order-domain';
import type { KillSwitchState } from './risk-manager';

export const INTERNAL_STATE_UNAVAILABLE = 'INTERNAL_STATE_UNAVAILABLE';
const INTERNAL_STATE_URL = 'https://internal-state/';
const DRY_RUN_STATE_URL = 'https://dry-run-state/';
const RISK_STATE_URL = 'https://risk-state/';
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

export function postKillSwitchCommand(env: Env, body: unknown): Promise<Response> {
  return postJson(getPrimaryStore(env, 'RISK_STATE_STORE'), RISK_STATE_URL, body);
}
