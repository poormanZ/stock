import type { Account, AuditLog, DryRunResult, DryRunState, KillSwitch, OrdersResponse, Reconciliation, TradingState } from './types';

export class WorkerApiError extends Error {
  constructor(public readonly code: string, public readonly status: number, message?: string) {
    super(message ?? code);
    this.name = 'WorkerApiError';
  }
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string; reason?: string };
  if (!response.ok) throw new WorkerApiError(body.error ?? `HTTP_${response.status}`, response.status, body.message ?? body.reason);
  return body as T;
}

/** Worker 호출 래퍼. 브라우저는 KIS Secret을 갖지 않으며 이 클라이언트가 유일한 서버 접점이다 */
export class WorkerApi {
  constructor(private readonly baseUrl: string) {}

  private get<T>(path: string): Promise<T> {
    return request<T>(this.baseUrl, path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return request<T>(this.baseUrl, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  account = () => this.get<Account>('/account');
  dryRun = () => this.get<DryRunState>('/dry-run');
  orders = () => this.get<OrdersResponse>('/orders');
  reconciliation = () => this.get<Reconciliation>('/reconciliation');
  risk = () => this.get<KillSwitch>('/risk');
  tradingStatus = () => this.get<TradingState>('/trading/status');
  audit = (limit: number) => this.get<AuditLog>(`/audit?limit=${limit}`);

  placeDryRunOrder = (body: unknown) => this.post<DryRunResult>('/dry-run/orders', body);
  resetDryRun = (initialCash: number) => this.post<DryRunState>('/dry-run/reset', { initialCash });
  startTrading = (config?: unknown) => this.post<TradingState>('/trading/start', config ? { config } : {});
  stopTrading = () => this.post<TradingState>('/trading/stop', {});
  runTrading = () => this.post<unknown>('/trading/run', {});
  setKillSwitch = (activate: boolean, reason?: string) => this.post<KillSwitch>('/risk/kill-switch', activate ? { action: 'activate', reason } : { action: 'deactivate' });
}
