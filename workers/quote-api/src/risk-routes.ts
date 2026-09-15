import { json, withCors, type RouteContext } from './http';
import { fetchKillSwitch, postKillSwitchCommand } from './state-clients';

export async function handleRiskState({ env, origin }: RouteContext): Promise<Response> {
  return withCors(await fetchKillSwitch(env), origin);
}

export async function handleKillSwitch({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'INVALID_KILL_SWITCH_REQUEST' }, 400, origin);
  return withCors(await postKillSwitchCommand(env, body), origin);
}
