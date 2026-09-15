import { createAccountAdapter, createOrderAdapter, type Env } from './env';
import { todayKst } from './kis-common';
import type { ReconciliationState } from './reconciliation';
import { reconcile, type ReconciliationResult } from './reconciliation';
import { readInternalState } from './state-clients';

/** KIS 계좌/당일 주문내역과 내부 상태를 대조한다. 내부 상태를 이미 읽었다면 재조회를 생략한다 */
export async function reconcileWithKis(env: Env, internalState?: ReconciliationState): Promise<ReconciliationResult> {
  const today = todayKst();
  const [account, history, internal] = await Promise.all([
    createAccountAdapter(env).getSnapshot(),
    createOrderAdapter(env).getOrderHistory(today, today),
    internalState ?? readInternalState(env),
  ]);
  return reconcile(
    {
      positions: account.positions.map(({ symbol, quantity }) => ({ symbol, quantity })),
      orders: history.orders.map(({ brokerOrderId, status, symbol, side, quantity, executedQuantity }) => ({
        brokerOrderId, status, symbol, side, quantity, executedQuantity,
      })),
    },
    internal,
  );
}
