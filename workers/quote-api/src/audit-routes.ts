import { withCors, type RouteContext } from './http';
import { fetchAuditLog } from './state-clients';

export async function handleAuditLog({ url, env, origin }: RouteContext): Promise<Response> {
  return withCors(await fetchAuditLog(env, url.searchParams), origin);
}
