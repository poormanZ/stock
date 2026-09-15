import { type KISEnvironment, type KISResponseMeta, validateAccountParts } from './kis-common';
import type { KISHttpClient } from './kis-http-client';
import { assertOrderRequest, transitionOrder, type CreateOrderRequest, type Order } from './order-domain';

const ORDER_PATH = '/uapi/domestic-stock/v1/trading/order-cash';
const CANCEL_PATH = '/uapi/domestic-stock/v1/trading/order-rvsecncl';
const PAPER_BUY_TR_ID = 'VTTC0012U';
const PAPER_SELL_TR_ID = 'VTTC0011U';
const PAPER_CANCEL_TR_ID = 'VTTC0013U';
const EXCHANGE_ID = 'KRX';

type RawOrderResponse = KISResponseMeta & {
  output?: {
    KRX_FWDG_ORD_ORGNO?: string;
    ODNO?: string;
    ORD_TMD?: string;
  };
};

export interface PaperOrderSubmission {
  accepted: boolean;
  brokerOrderId?: string;
  brokerOrderOrgNo?: string;
  orderTime?: string;
  messageCode?: string;
  message?: string;
}

export interface PaperOrderCancellation {
  accepted: boolean;
  brokerOrderId?: string;
  orderTime?: string;
  messageCode?: string;
  message?: string;
}

export class KISPaperOrderAdapter {
  private readonly cano: string;
  private readonly accountProductCode: string;

  constructor(
    private readonly client: KISHttpClient,
    private readonly environment: KISEnvironment,
    cano: string,
    accountProductCode: string,
  ) {
    this.cano = cano.trim();
    this.accountProductCode = accountProductCode.trim();
  }

  /** 네트워크 호출 없이 전송 가능 여부만 검증한다. 라우트가 SUBMITTING 기록 전에 호출한다 */
  assertSubmittable(request: CreateOrderRequest): void {
    this.assertPaperAccount();
    assertOrderRequest(request);
    if (request.clientOrderId.startsWith('DRY-')) throw new Error('DRY_RUN_ORDER_NOT_ALLOWED_ON_PAPER');
  }

  async submit(request: CreateOrderRequest): Promise<PaperOrderSubmission> {
    this.assertSubmittable(request);

    const isBuy = request.side === 'buy';
    const body = {
      CANO: this.cano,
      ACNT_PRDT_CD: this.accountProductCode,
      PDNO: request.symbol,
      ORD_DVSN: request.orderType === 'market' ? '01' : '00',
      ORD_QTY: String(request.quantity),
      ORD_UNPR: request.orderType === 'market' ? '0' : String(request.limitPrice),
      EXCG_ID_DVSN_CD: EXCHANGE_ID,
      SLL_TYPE: isBuy ? '' : '01',
      CNDT_PRIC: '',
    };

    const response = await this.client.postJsonResponse<RawOrderResponse>(ORDER_PATH, body, {
      tr_id: isBuy ? PAPER_BUY_TR_ID : PAPER_SELL_TR_ID,
      custtype: 'P',
    });

    const data = response.data;
    if (data.rt_cd !== '0') {
      return { accepted: false, messageCode: data.msg_cd, message: data.msg1 };
    }

    const brokerOrderId = data.output?.ODNO?.trim();
    if (!brokerOrderId) throw new Error('PAPER_ORDER_RESPONSE_MISSING_ORDER_ID');
    const brokerOrderOrgNo = data.output?.KRX_FWDG_ORD_ORGNO?.trim();
    if (!brokerOrderOrgNo) throw new Error('PAPER_ORDER_RESPONSE_MISSING_ORDER_ORGNO');
    return {
      accepted: true,
      brokerOrderId,
      brokerOrderOrgNo,
      orderTime: data.output?.ORD_TMD?.trim(),
      messageCode: data.msg_cd,
      message: data.msg1,
    };
  }

  async cancel(order: Order): Promise<PaperOrderCancellation> {
    this.assertPaperAccount();
    if (!order.brokerOrderId) throw new Error('PAPER_ORDER_BROKER_ID_REQUIRED');
    if (!order.brokerOrderOrgNo) throw new Error('PAPER_ORDER_BROKER_ORGNO_REQUIRED');

    const response = await this.client.postJsonResponse<RawOrderResponse>(CANCEL_PATH, {
      CANO: this.cano,
      ACNT_PRDT_CD: this.accountProductCode,
      KRX_FWDG_ORD_ORGNO: order.brokerOrderOrgNo,
      ORGN_ODNO: order.brokerOrderId,
      ORD_DVSN: order.orderType === 'market' ? '01' : '00',
      RVSE_CNCL_DVSN_CD: '02',
      ORD_QTY: '0',
      ORD_UNPR: '0',
      QTY_ALL_ORD_YN: 'Y',
      EXCG_ID_DVSN_CD: EXCHANGE_ID,
      CNDT_PRIC: '',
    }, { tr_id: PAPER_CANCEL_TR_ID, custtype: 'P' });

    const data = response.data;
    if (data.rt_cd !== '0') return { accepted: false, messageCode: data.msg_cd, message: data.msg1 };
    return {
      accepted: true,
      brokerOrderId: data.output?.ODNO?.trim(),
      orderTime: data.output?.ORD_TMD?.trim(),
      messageCode: data.msg_cd,
      message: data.msg1,
    };
  }

  private assertPaperAccount(): void {
    if (this.environment !== 'PAPER') throw new Error('PAPER_ORDER_REQUIRES_PAPER_ENVIRONMENT');
    validateAccountParts(this.cano, this.accountProductCode);
  }
}

/** 브로커 접수 결과를 상태 머신(SUBMITTING → SUBMITTED → ACCEPTED)을 거쳐 반영한다 */
export function toPaperAcceptedOrder(order: Order, submission: PaperOrderSubmission): Order {
  if (!submission.accepted || !submission.brokerOrderId) throw new Error('PAPER_ORDER_NOT_ACCEPTED');
  const submitted = order.status === 'SUBMITTING' ? transitionOrder(order, 'SUBMITTED') : order;
  return transitionOrder(submitted, 'ACCEPTED', {
    brokerOrderId: submission.brokerOrderId,
    brokerOrderOrgNo: submission.brokerOrderOrgNo,
  });
}
