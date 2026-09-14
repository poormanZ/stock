import type { KISHttpClient } from './kis-http-client';
import type { CreateOrderRequest, Order } from './order-domain';

const ORDER_PATH = '/uapi/domestic-stock/v1/trading/order-cash';
const CANCEL_PATH = '/uapi/domestic-stock/v1/trading/order-rvsecncl';
const PAPER_BUY_TR_ID = 'VTTC0012U';
const PAPER_SELL_TR_ID = 'VTTC0011U';
const PAPER_CANCEL_TR_ID = 'VTTC0013U';
const EXCHANGE_ID = 'KRX';

interface RawOrderResponse {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
  output?: {
    KRX_FWDG_ORD_ORGNO?: string;
    ODNO?: string;
    ORD_TMD?: string;
  };
}

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

function validateAccount(cano: string, accountProductCode: string): void {
  if (!/^\d{8}$/.test(cano.trim())) throw new Error('KIS account CANO must use 8 digits');
  if (accountProductCode.trim() !== '01') throw new Error('KIS consignment account product code must be 01');
}

function validateRequest(request: CreateOrderRequest): void {
  if (request.clientOrderId.startsWith('DRY-')) throw new Error('DRY_RUN_ORDER_NOT_ALLOWED_ON_PAPER');
  if (!/^\d{6}$/.test(request.symbol)) throw new Error('INVALID_ORDER_SYMBOL');
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) throw new Error('INVALID_ORDER_QUANTITY');
  if (request.orderType === 'limit' && (!Number.isFinite(request.limitPrice) || (request.limitPrice ?? 0) <= 0)) {
    throw new Error('INVALID_LIMIT_PRICE');
  }
  if (request.orderType === 'market' && request.limitPrice !== undefined) throw new Error('MARKET_ORDER_PRICE_NOT_ALLOWED');
}

export class KISPaperOrderAdapter {
  constructor(
    private readonly client: KISHttpClient,
    private readonly environment: 'PAPER' | 'LIVE',
    private readonly cano: string,
    private readonly accountProductCode: string,
  ) {}

  async submit(request: CreateOrderRequest): Promise<PaperOrderSubmission> {
    if (this.environment !== 'PAPER') throw new Error('PAPER_ORDER_REQUIRES_PAPER_ENVIRONMENT');
    validateAccount(this.cano, this.accountProductCode);
    validateRequest(request);

    const isBuy = request.side === 'buy';
    const body = {
      CANO: this.cano.trim(),
      ACNT_PRDT_CD: this.accountProductCode.trim(),
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
    if (this.environment !== 'PAPER') throw new Error('PAPER_ORDER_REQUIRES_PAPER_ENVIRONMENT');
    validateAccount(this.cano, this.accountProductCode);
    if (!order.brokerOrderId) throw new Error('PAPER_ORDER_BROKER_ID_REQUIRED');
    if (!order.brokerOrderOrgNo) throw new Error('PAPER_ORDER_BROKER_ORGNO_REQUIRED');

    const response = await this.client.postJsonResponse<RawOrderResponse>(CANCEL_PATH, {
      CANO: this.cano.trim(),
      ACNT_PRDT_CD: this.accountProductCode.trim(),
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
}

export function toPaperAcceptedOrder(order: Order, submission: PaperOrderSubmission): Order {
  if (!submission.accepted || !submission.brokerOrderId) throw new Error('PAPER_ORDER_NOT_ACCEPTED');
  return {
    ...order,
    brokerOrderId: submission.brokerOrderId,
    brokerOrderOrgNo: submission.brokerOrderOrgNo,
    status: 'ACCEPTED',
    updatedAt: new Date().toISOString(),
  };
}
