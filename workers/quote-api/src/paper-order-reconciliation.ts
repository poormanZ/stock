import { transitionOrder, type Order } from './order-domain';
import type { OrderRecord } from './kis-order-adapter';

export interface PaperOrderResyncResult {
  orders: Order[];
  updated: number;
  unresolved: string[];
}

function assertExecutedQuantity(order: Order, executedQuantity: number): void {
  if (!Number.isInteger(executedQuantity) || executedQuantity < 0 || executedQuantity > order.quantity) throw new Error('INVALID_EXECUTED_QUANTITY');
  if (order.status === 'FILLED' && executedQuantity !== order.quantity) throw new Error('FILLED_QUANTITY_MISMATCH');
  if (order.status === 'PARTIALLY_FILLED' && (executedQuantity <= 0 || executedQuantity >= order.quantity)) throw new Error('INVALID_PARTIAL_FILL_QUANTITY');
}

/**
 * Merge broker order/filled state into internal Order records.
 * Only orders that already have a brokerOrderId are updated; KIS-only orders
 * remain unresolved so the caller can handle them through reconciliation.
 *
 * State changes are applied through the Order state machine so a broker
 * response cannot silently create an illegal internal transition. Unchanged
 * orders are returned by reference so callers can detect changes with `!==`.
 */
export function resyncPaperOrders(internalOrders: Order[], brokerOrders: OrderRecord[]): PaperOrderResyncResult {
  const brokerById = new Map(brokerOrders.filter((order) => order.brokerOrderId).map((order) => [order.brokerOrderId, order]));
  let updated = 0;

  const orders = internalOrders.map((order) => {
    if (!order.brokerOrderId) return order;
    const broker = brokerById.get(order.brokerOrderId);
    if (!broker) return order;

    const { executedQuantity, averageExecutedPrice, status: nextStatus } = broker;
    const changed = order.status !== nextStatus || order.executedQuantity !== executedQuantity || order.averageExecutedPrice !== averageExecutedPrice;
    if (!changed) return order;
    updated += 1;

    if (order.status === nextStatus) {
      assertExecutedQuantity(order, executedQuantity);
      return { ...order, executedQuantity, averageExecutedPrice, updatedAt: new Date().toISOString() };
    }

    // UNKNOWN은 RECONCILING을 거쳐서만 실제 상태로 복구할 수 있다
    const base = order.status === 'UNKNOWN' ? transitionOrder(order, 'RECONCILING') : order;
    return transitionOrder(base, nextStatus, { executedQuantity, averageExecutedPrice });
  });

  const knownIds = new Set(internalOrders.map((order) => order.brokerOrderId).filter(Boolean));
  const unresolved = brokerOrders.filter((order) => order.brokerOrderId && !knownIds.has(order.brokerOrderId)).map((order) => order.brokerOrderId);
  return { orders, updated, unresolved };
}
