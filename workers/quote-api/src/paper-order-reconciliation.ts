import type { Order } from './order-domain';
import type { OrderRecord } from './kis-order-adapter';

export interface PaperOrderResyncResult {
  orders: Order[];
  updated: number;
  unresolved: string[];
}

/**
 * Merge broker order/filled state into internal Order records.
 * Only orders that already have a brokerOrderId are updated; KIS-only orders
 * remain unresolved so the caller can handle them through reconciliation.
 */
export function resyncPaperOrders(internalOrders: Order[], brokerOrders: OrderRecord[]): PaperOrderResyncResult {
  const brokerById = new Map(brokerOrders.filter((order) => order.brokerOrderId).map((order) => [order.brokerOrderId, order]));
  let updated = 0;

  const orders = internalOrders.map((order) => {
    if (!order.brokerOrderId) return order;
    const broker = brokerById.get(order.brokerOrderId);
    if (!broker) return order;

    const nextStatus: Order['status'] = broker.status;
    const executedQuantity = broker.executedQuantity;
    const averageExecutedPrice = broker.averageExecutedPrice;
    const changed = order.status !== nextStatus || order.executedQuantity !== executedQuantity || order.averageExecutedPrice !== averageExecutedPrice;
    if (!changed) return order;

    updated += 1;
    return {
      ...order,
      status: nextStatus,
      executedQuantity,
      averageExecutedPrice,
      updatedAt: new Date().toISOString(),
    };
  });

  const knownIds = new Set(internalOrders.map((order) => order.brokerOrderId).filter(Boolean));
  const unresolved = brokerOrders.filter((order) => order.brokerOrderId && !knownIds.has(order.brokerOrderId)).map((order) => order.brokerOrderId);
  return { orders, updated, unresolved };
}
