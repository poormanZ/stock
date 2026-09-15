import { KISCashOrderAdapter, toAcceptedOrder, type CashOrderCancellation, type CashOrderSubmission } from './kis-cash-order-adapter';
import type { KISEnvironment } from './kis-common';
import type { KISHttpClient } from './kis-http-client';
import type { Order } from './order-domain';

export type PaperOrderSubmission = CashOrderSubmission;
export type PaperOrderCancellation = CashOrderCancellation;

/** 모의투자(PAPER) 전용 현금주문 어댑터. 클라이언트 환경이 PAPER가 아니면 어떤 요청도 보내지 않는다 */
export class KISPaperOrderAdapter extends KISCashOrderAdapter {
  constructor(client: KISHttpClient, environment: KISEnvironment, cano: string, accountProductCode: string) {
    super(client, environment, cano, accountProductCode, 'PAPER');
  }
}

export function toPaperAcceptedOrder(order: Order, submission: PaperOrderSubmission): Order {
  try {
    return toAcceptedOrder(order, submission);
  } catch (error) {
    if (error instanceof Error && error.message === 'ORDER_NOT_ACCEPTED') throw new Error('PAPER_ORDER_NOT_ACCEPTED');
    throw error;
  }
}
