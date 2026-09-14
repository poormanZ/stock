import { assertOrderRequest, type CreateOrderRequest } from './order-domain';
import type { ReconciliationResult } from './reconciliation';

export interface OrderGateResult {
  allowed: boolean;
  reason: 'OK' | 'RECONCILIATION_MISMATCH' | 'INVALID_ORDER';
  reconciliation: ReconciliationResult;
}

export function checkNewOrderGate(request: CreateOrderRequest, reconciliation: ReconciliationResult): OrderGateResult {
  try {
    assertOrderRequest(request);
  } catch {
    return { allowed: false, reason: 'INVALID_ORDER', reconciliation };
  }
  if (!reconciliation.canPlaceNewOrders) {
    return { allowed: false, reason: 'RECONCILIATION_MISMATCH', reconciliation };
  }
  return { allowed: true, reason: 'OK', reconciliation };
}

export function assertNewOrderAllowed(request: CreateOrderRequest, reconciliation: ReconciliationResult): void {
  const result = checkNewOrderGate(request, reconciliation);
  if (!result.allowed) throw new Error(result.reason);
}
