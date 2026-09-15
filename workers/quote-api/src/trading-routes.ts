import { getEnvironment, type Env } from './env';
import { errorMessage, json, withCors, type RouteContext } from './http';
import { appendAudit, fetchTradingState, postTradingCommand, readKillSwitch } from './state-clients';
import { runTradingCycle } from './trading-engine';
import { validateTradingConfig, type TradingConfig, type TradingState } from './trading-state';

function parseConfig(env: Env, value: unknown): { config: TradingConfig } | { error: string } {
  try {
    const config = validateTradingConfig(value);
    if (config.mode === 'PAPER' && getEnvironment(env) !== 'PAPER') return { error: 'PAPER_ENVIRONMENT_REQUIRED' };
    return { config };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function handleTradingStatus({ env, origin }: RouteContext): Promise<Response> {
  return withCors(await fetchTradingState(env), origin);
}

export async function handleTradingRuns({ env, url, origin }: RouteContext): Promise<Response> {
  const response = await fetchTradingState(env);
  if (!response.ok) return withCors(response, origin);
  const state = (await response.json()) as TradingState;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), state.runs.length || 1);
  return json({ status: state.status, runs: [...state.runs].reverse().slice(0, limit) }, 200, origin);
}

export async function handleTradingConfigure({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null) as { config?: unknown } | null;
  const parsed = parseConfig(env, body?.config ?? body);
  if ('error' in parsed) return json({ error: 'INVALID_TRADING_CONFIG', reason: parsed.error }, 400, origin);
  const response = await postTradingCommand(env, { action: 'configure', config: parsed.config });
  if (response.ok) await appendAudit(env, { type: 'SCHEDULER_RUN', mode: parsed.config.mode, message: `trading configured: ${parsed.config.strategy.id} ${parsed.config.symbols.join(',')}` });
  return withCors(response, origin);
}

export async function handleTradingStart({ request, env, origin }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null) as { config?: unknown } | null;
  let config: TradingConfig | undefined;
  if (body?.config !== undefined) {
    const parsed = parseConfig(env, body.config);
    if ('error' in parsed) return json({ error: 'INVALID_TRADING_CONFIG', reason: parsed.error }, 400, origin);
    config = parsed.config;
  }
  // Kill Switch가 켜진 상태에서 시작하면 다음 사이클에 EMERGENCY_STOP으로 바뀔 뿐이므로 처음부터 거부한다.
  // 꺼져 있음을 여기서 확인했으므로 EMERGENCY_STOP 상태에서의 재시작을 DO에 명시적으로 허용한다.
  if ((await readKillSwitch(env)).active) return json({ error: 'KILL_SWITCH_ACTIVE' }, 409, origin);
  const response = await postTradingCommand(env, { action: 'start', acknowledgeEmergencyStop: true, ...(config ? { config } : {}) });
  if (response.ok) {
    const state = (await response.clone().json()) as TradingState;
    await appendAudit(env, { type: 'SCHEDULER_RUN', mode: state.config?.mode ?? 'DRY_RUN', message: 'trading started' });
  }
  return withCors(response, origin);
}

export async function handleTradingStop({ env, origin }: RouteContext): Promise<Response> {
  const response = await postTradingCommand(env, { action: 'stop' });
  if (response.ok) await appendAudit(env, { type: 'SCHEDULER_RUN', mode: 'SYSTEM', message: 'trading stopped' });
  return withCors(response, origin);
}

/** 수동 1회 실행. cron과 같은 경로를 타므로 RUNNING 상태와 lease 규칙을 그대로 따른다 */
export async function handleTradingRun({ env, origin }: RouteContext): Promise<Response> {
  const result = await runTradingCycle(env, 'manual');
  return json(result, result.ran ? 200 : 409, origin);
}
