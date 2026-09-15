import type { Account, AuditLog, DryRunState, KillSwitch, OrdersResponse, Reconciliation, TradingState } from './api/types';
import type { StockQuote } from './types/stock';

export type HistoryTab = 'dry-run' | 'runs' | 'audit' | 'kis';
export type MessageTone = 'info' | 'ok' | 'bad';

export interface AppState {
  live: boolean;
  busy: boolean;
  message: string;
  messageTone: MessageTone;
  failures: string[];
  lastSync?: string;
  autoRefresh: boolean;
  stocks: StockQuote[];
  quotes: StockQuote[];
  account: Account | null;
  dryRun: DryRunState | null;
  orderHistory: OrdersResponse | null;
  reconciliation: Reconciliation | null;
  killSwitch: KillSwitch | null;
  trading: TradingState | null;
  audit: AuditLog | null;
  selectedSymbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: number;
  limitPrice: number;
  historyTab: HistoryTab;
  expandedRunId: string | null;
}

const PREFS_KEY = 'stock-dashboard.prefs';

interface Prefs { autoRefresh?: boolean; historyTab?: HistoryTab; }

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) as Prefs : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 사설 브라우징 등에서 localStorage가 막혀 있어도 동작에는 영향이 없다
  }
}

export function createState(live: boolean, stocks: StockQuote[]): AppState {
  const prefs = loadPrefs();
  return {
    live,
    busy: false,
    message: live ? '동기화 대기 중' : '샘플 모드',
    messageTone: 'info',
    failures: [],
    autoRefresh: prefs.autoRefresh ?? true,
    stocks,
    quotes: [],
    account: null,
    dryRun: null,
    orderHistory: null,
    reconciliation: null,
    killSwitch: null,
    trading: null,
    audit: null,
    selectedSymbol: stocks[0]?.symbol ?? '005930',
    side: 'buy',
    orderType: 'limit',
    quantity: 1,
    limitPrice: 0,
    historyTab: prefs.historyTab ?? 'dry-run',
    expandedRunId: null,
  };
}

export const selectedQuote = (state: AppState): StockQuote | undefined => state.quotes.find((quote) => quote.symbol === state.selectedSymbol);
