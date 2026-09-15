import { sendAlert } from './alerts';
import { json, withCors, type RouteContext } from './http';
import type { KillSwitchState } from './risk-manager';
import { appendAudit, fetchKillSwitch, postKillSwitchCommand } from './state-clients';

export async function handleRiskState({ env, origin }: RouteContext): Promise<Response> {
  return withCors(await fetchKillSwitch(env), origin);
}

export async function handleKillSwitch({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_KILL_SWITCH_REQUEST' }, 400, origin);

  const response = await postKillSwitchCommand(env, body);
  if (response.ok) {
    const state = (await response.clone().json()) as KillSwitchState;
    const message = state.active ? `kill switch activated: ${state.reason ?? 'manual'}` : 'kill switch deactivated';
    await appendAudit(env, { type: 'EMERGENCY_STOP', mode: 'SYSTEM', message, details: { active: state.active } });
    if (state.active) await sendAlert(env, { level: 'CRITICAL', title: 'EMERGENCY_STOP', message });
  }
  return withCors(response, origin);
}
