/** Worker 응답 타입. 필드명은 workers/quote-api의 실제 응답과 맞춘다 */

export type OrderStatus = 'CREATED' | 'SUBMITTING' | 'SUBMITTED' | 'ACCEPTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCEL_PENDING' | 'CANCELED' | 'REJECTED' | 'UNKNOWN' | 'RECONCILING';
export type TradingStatus = 'STOPPED' | 'READY' | 'RUNNING' | 'ERROR' | 'EMERGENCY_STOP';

export interface AccountPosition {
  symbol: string;
  name?: string;
  quantity: number;
  averagePrice?: number;
  currentPrice?: number;
  evaluationAmount?: number;
  profitLossAmount?: number;
  profitLossPercent?: number;
}

export interface Account {
  asOf: string;
  environment: string;
  cash: number;
  settlementD1Cash: number;
  settlementD2Cash: number;
  totalEquity: number;
  netAssetValue: number;
  positions: AccountPosition[];
}

export interface Order {
  id: string;
  clientOrderId: string;
  brokerOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: number;
  limitPrice?: number;
  reason?: string;
  executedQuantity: number;
  averageExecutedPrice: number;
  status: OrderStatus | string;
  createdAt: string;
  updatedAt: string;
}

export interface DryRunState {
  cash: number;
  positions: { symbol: string; quantity: number; averagePrice: number }[];
  orders: Order[];
  updatedAt: string;
  realized?: { date: string; pnl: number };
}

export interface DryRunResult {
  mode: string;
  idempotent?: boolean;
  order: Order;
  cash: number;
  executedPrice?: number;
  fee?: number;
  tax?: number;
}

export interface KisOrderRecord {
  brokerOrderId: string;
  symbol: string;
  name: string;
  side: 'buy' | 'sell' | 'unknown';
  orderType: string;
  quantity: number;
  orderPrice: number;
  executedQuantity: number;
  averageExecutedPrice: number;
  status: string;
  orderTime: string;
}

export interface OrdersResponse { asOf: string; orders: KisOrderRecord[]; }

export interface Reconciliation {
  asOf?: string;
  status: 'MATCHED' | 'MISMATCHED';
  canPlaceNewOrders: boolean;
  differences: { type: string; symbol?: string; brokerOrderId?: string; message: string }[];
}

export interface KillSwitch {
  active: boolean;
  reason?: string;
  activatedAt?: string;
  updatedAt: string;
  liveArm?: { armedUntil: string; reason: string } | null;
}

export interface TradingRunSignal { symbol: string; action: string; reason: string; price?: number; }
export interface TradingRunOrder { symbol: string; side: 'buy' | 'sell'; quantity: number; clientOrderId: string; status: number | 'ERROR'; result: string; reason?: string; price?: number; }

export interface TradingRun {
  id: string;
  trigger: 'cron' | 'manual';
  mode: string;
  startedAt: string;
  finishedAt: string;
  status: 'OK' | 'SKIPPED' | 'ERROR';
  reason?: string;
  signals: TradingRunSignal[];
  orders: TradingRunOrder[];
  error?: { source: string; message: string };
}

export interface TradingConfig {
  mode: 'DRY_RUN' | 'PAPER';
  symbols: string[];
  strategy: { id: string; params: Record<string, number> };
  exit: { stopLossPct: number; takeProfitPct: number };
  sizing: { cashFraction: number; maxOrderAmount: number; maxOrderQuantity: number; maxPositionQuantity: number };
  candleBars: number;
}

export interface TradingState {
  status: TradingStatus;
  config: TradingConfig | null;
  lastRun?: TradingRun;
  runs: TradingRun[];
  error?: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  type: string;
  mode: string;
  symbol?: string;
  clientOrderId?: string;
  message: string;
}

export interface AuditLog { count: number; events: AuditEvent[]; }
