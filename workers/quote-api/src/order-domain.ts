export const ORDER_STATUSES = ['CREATED', 'SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN', 'RECONCILING'] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';

export interface Order {
  id: string;
  clientOrderId: string;
  brokerOrderId?: string;
  brokerOrderOrgNo?: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  limitPrice?: number;
  executedQuantity: number;
  averageExecutedPrice: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderRequest {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  limitPrice?: number;
}

const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ['SUBMITTING', 'CANCELED'],
  SUBMITTING: ['SUBMITTED', 'REJECTED', 'UNKNOWN'],
  SUBMITTED: ['ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN'],
  ACCEPTED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'UNKNOWN'],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  UNKNOWN: ['RECONCILING'],
  RECONCILING: ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN'],
};

export const CANCELLABLE_STATUSES: ReadonlySet<OrderStatus> = new Set(['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED']);

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return transitions[from].includes(to);
}

export function assertOrderRequest(request: CreateOrderRequest): void {
  if (!request || typeof request !== 'object') throw new Error('INVALID_ORDER_REQUEST');
  if (typeof request.id !== 'string' || !request.id || typeof request.clientOrderId !== 'string' || !request.clientOrderId) throw new Error('ORDER_ID_REQUIRED');
  if (typeof request.symbol !== 'string' || !/^\d{6}$/.test(request.symbol)) throw new Error('INVALID_ORDER_SYMBOL');
  if (request.side !== 'buy' && request.side !== 'sell') throw new Error('INVALID_ORDER_SIDE');
  if (request.orderType !== 'market' && request.orderType !== 'limit') throw new Error('INVALID_ORDER_TYPE');
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) throw new Error('INVALID_ORDER_QUANTITY');
  if (request.orderType === 'limit' && (!Number.isFinite(request.limitPrice) || (request.limitPrice ?? 0) <= 0)) throw new Error('INVALID_LIMIT_PRICE');
  if (request.orderType === 'market' && request.limitPrice !== undefined) throw new Error('MARKET_ORDER_PRICE_NOT_ALLOWED');
}

export function isValidOrderRequest(value: unknown): value is CreateOrderRequest {
  try {
    assertOrderRequest(value as CreateOrderRequest);
    return true;
  } catch {
    return false;
  }
}

/** 요청의 알려진 필드만 복사해 CREATED 주문을 만든다 (클라이언트가 보낸 임의 필드가 저장되지 않도록) */
export function createOrder(request: CreateOrderRequest, now = new Date().toISOString()): Order {
  return {
    id: request.id,
    clientOrderId: request.clientOrderId,
    symbol: request.symbol,
    side: request.side,
    orderType: request.orderType,
    quantity: request.quantity,
    limitPrice: request.limitPrice,
    executedQuantity: 0,
    averageExecutedPrice: 0,
    status: 'CREATED',
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionOrder(order: Order, nextStatus: OrderStatus, patch: Partial<Pick<Order, 'brokerOrderId' | 'brokerOrderOrgNo' | 'executedQuantity' | 'averageExecutedPrice'>> = {}): Order {
  if (!canTransition(order.status, nextStatus)) throw new Error(`INVALID_ORDER_TRANSITION:${order.status}->${nextStatus}`);
  const executedQuantity = patch.executedQuantity ?? order.executedQuantity;
  if (!Number.isInteger(executedQuantity) || executedQuantity < 0 || executedQuantity > order.quantity) throw new Error('INVALID_EXECUTED_QUANTITY');
  if (nextStatus === 'FILLED' && executedQuantity !== order.quantity) throw new Error('FILLED_QUANTITY_MISMATCH');
  if (nextStatus === 'PARTIALLY_FILLED' && (executedQuantity <= 0 || executedQuantity >= order.quantity)) throw new Error('INVALID_PARTIAL_FILL_QUANTITY');
  return { ...order, ...patch, status: nextStatus, updatedAt: new Date().toISOString() };
}
