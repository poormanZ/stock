export interface ReconciliationPosition {
  symbol: string;
  quantity: number;
  averagePrice?: number;
}

export interface ReconciliationOrder {
  brokerOrderId: string;
  clientOrderId?: string;
  status: string;
  symbol: string;
  side: 'buy' | 'sell' | 'unknown';
  quantity: number;
  executedQuantity: number;
}

export interface ReconciliationState {
  positions: ReconciliationPosition[];
  orders: ReconciliationOrder[];
}

export interface ReconciliationDifference {
  type: 'POSITION_QUANTITY_MISMATCH' | 'MISSING_INTERNAL_POSITION' | 'UNEXPECTED_INTERNAL_POSITION' | 'ORDER_STATUS_MISMATCH' | 'MISSING_INTERNAL_ORDER' | 'UNEXPECTED_INTERNAL_ORDER';
  symbol?: string;
  brokerOrderId?: string;
  message: string;
}

export interface ReconciliationResult {
  status: 'MATCHED' | 'MISMATCHED';
  canPlaceNewOrders: boolean;
  differences: ReconciliationDifference[];
}

function positionMap(positions: ReconciliationPosition[]): Map<string, number> {
  return new Map(positions.filter((position) => /^\d{6}$/.test(position.symbol) && position.quantity > 0).map((position) => [position.symbol, position.quantity]));
}

function isNonTerminalOrder(status: string): boolean {
  return !['FILLED', 'CANCELED', 'REJECTED'].includes(status);
}

export function reconcile(kis: ReconciliationState, internal: ReconciliationState): ReconciliationResult {
  const differences: ReconciliationDifference[] = [];
  const kisPositions = positionMap(kis.positions);
  const internalPositions = positionMap(internal.positions);
  for (const [symbol, quantity] of kisPositions) {
    const internalQuantity = internalPositions.get(symbol);
    if (internalQuantity === undefined) differences.push({ type: 'MISSING_INTERNAL_POSITION', symbol, message: `KIS position ${symbol} is missing from internal state` });
    else if (internalQuantity !== quantity) differences.push({ type: 'POSITION_QUANTITY_MISMATCH', symbol, message: `Position ${symbol} quantity differs: KIS=${quantity}, internal=${internalQuantity}` });
  }
  for (const symbol of internalPositions.keys()) if (!kisPositions.has(symbol)) differences.push({ type: 'UNEXPECTED_INTERNAL_POSITION', symbol, message: `Internal position ${symbol} is not present at KIS` });

  const kisOrders = new Map(kis.orders.filter((order) => order.brokerOrderId).map((order) => [order.brokerOrderId, order]));
  const internalOrders = new Map(internal.orders.filter((order) => order.brokerOrderId).map((order) => [order.brokerOrderId, order]));
  for (const [brokerOrderId, kisOrder] of kisOrders) {
    const internalOrder = internalOrders.get(brokerOrderId);
    if (!internalOrder) differences.push({ type: 'MISSING_INTERNAL_ORDER', brokerOrderId, symbol: kisOrder.symbol, message: `KIS order ${brokerOrderId} is missing from internal state` });
    else if (internalOrder.status !== kisOrder.status || internalOrder.executedQuantity !== kisOrder.executedQuantity) differences.push({ type: 'ORDER_STATUS_MISMATCH', brokerOrderId, message: `Order ${brokerOrderId} state differs: KIS=${kisOrder.status}/${kisOrder.executedQuantity}, internal=${internalOrder.status}/${internalOrder.executedQuantity}` });
  }
  for (const [brokerOrderId, internalOrder] of internalOrders) {
    if (!kisOrders.has(brokerOrderId) && isNonTerminalOrder(internalOrder.status)) {
      differences.push({ type: 'UNEXPECTED_INTERNAL_ORDER', brokerOrderId, symbol: internalOrder.symbol, message: `Active internal order ${brokerOrderId} is not present at KIS` });
    }
  }
  return { status: differences.length === 0 ? 'MATCHED' : 'MISMATCHED', canPlaceNewOrders: differences.length === 0, differences };
}
