import { toKstDate } from './kis-common';
import type { Order } from './order-domain';

export interface LedgerPosition {
  symbol: string;
  quantity: number;
  averagePrice: number;
}

/** KST 일자 기준 실현손익 누적. 날짜가 바뀌면 0부터 다시 시작한다 */
export interface RealizedPnl {
  date: string;
  pnl: number;
}

export interface Ledger {
  positions: LedgerPosition[];
  realized?: RealizedPnl;
}

function rollRealized(realized: RealizedPnl | undefined, today: string): RealizedPnl {
  return realized && realized.date === today ? { ...realized } : { date: today, pnl: 0 };
}

/** 당일 실현손실(양수). 이익이거나 다른 날짜면 0 */
export function dailyLossOf(realized: RealizedPnl | undefined, now: string | Date): number {
  const today = toKstDate(now);
  if (!realized || !today || realized.date !== today || realized.pnl >= 0) return 0;
  return -realized.pnl;
}

/** 실현손익(수수료·세금 차감 후)을 당일 누적에 더한다 */
export function addRealized<T extends Ledger>(ledger: T, pnl: number, now: string | Date): T {
  const today = toKstDate(now);
  if (!today || !Number.isFinite(pnl)) return ledger;
  const realized = rollRealized(ledger.realized, today);
  realized.pnl += pnl;
  return { ...ledger, realized };
}

/**
 * 주문 기록의 이전/현재 차이(체결 증분)를 포지션과 실현손익에 반영한다.
 * 같은 기록을 다시 적용하면 증분이 0이라 아무것도 바뀌지 않는다(멱등).
 */
export function applyFillDelta<T extends Ledger>(ledger: T, before: Order | undefined, after: Order, now: string | Date): T {
  const beforeQty = before?.executedQuantity ?? 0;
  const delta = after.executedQuantity - beforeQty;
  if (!Number.isInteger(delta) || delta <= 0) return ledger;

  const beforeAmount = beforeQty * (before?.averageExecutedPrice ?? 0);
  const afterAmount = after.executedQuantity * after.averageExecutedPrice;
  const fillPrice = afterAmount > beforeAmount ? (afterAmount - beforeAmount) / delta : after.averageExecutedPrice;

  const existing = ledger.positions.find((position) => position.symbol === after.symbol);
  const others = ledger.positions.filter((position) => position.symbol !== after.symbol);
  const today = toKstDate(now);
  const realized = today ? rollRealized(ledger.realized, today) : ledger.realized;

  if (after.side === 'buy') {
    const oldQty = existing?.quantity ?? 0;
    const quantity = oldQty + delta;
    const averagePrice = (oldQty * (existing?.averagePrice ?? 0) + delta * fillPrice) / quantity;
    return { ...ledger, positions: [...others, { symbol: after.symbol, quantity, averagePrice }], realized };
  }

  // 매도: 보유량을 넘는 체결은 0으로 고정한다. 원인은 reconciliation에서 불일치로 드러난다
  const oldQty = existing?.quantity ?? 0;
  const sold = Math.min(delta, oldQty);
  if (realized && existing) realized.pnl += (fillPrice - existing.averagePrice) * sold;
  const remaining = oldQty - sold;
  const positions = remaining > 0 && existing ? [...others, { ...existing, quantity: remaining }] : others;
  return { ...ledger, positions, realized };
}

export function isLedgerPosition(value: unknown): value is LedgerPosition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LedgerPosition>;
  return typeof candidate.symbol === 'string' && /^\d{6}$/.test(candidate.symbol)
    && typeof candidate.quantity === 'number' && Number.isInteger(candidate.quantity) && candidate.quantity >= 0
    && typeof candidate.averagePrice === 'number' && Number.isFinite(candidate.averagePrice) && candidate.averagePrice >= 0;
}
