import { type KISEnvironment, type KISResponseMeta, validateAccountParts } from './kis-common';
import type { KISHttpClient } from './kis-http-client';
import { assertOrderRequest, transitionOrder, type CreateOrderRequest, type Order } from './order-domain';

const ORDER_PATH = '/uapi/domestic-stock/v1/trading/order-cash';
const CANCEL_PATH = '/uapi/domestic-stock/v1/trading/order-rvsecncl';
const EXCHANGE_ID = 'KRX';

/** 국내주식 현금주문 TR ID. 모의투자는 V, 실전투자는 T 접두어 */
const TR_IDS: Record<KISEnvironment, { buy: string; sell: string; cancel: string }> = {
  PAPER: { buy: 'VTTC0012U', sell: 'VTTC0011U', cancel: 'VTTC0013U' },
  LIVE: { buy: 'TTTC0012U', sell: 'TTTC0011U', cancel: 'TTTC0013U' },
};

type RawOrderResponse = KISResponseMeta & {
  output?: {
    KRX_FWDG_ORD_ORGNO?: string;
    ODNO?: string;
    ORD_TMD?: string;
  };
};

export interface CashOrderSubmission {
  accepted: boolean;
  brokerOrderId?: string;
  brokerOrderOrgNo?: string;
  orderTime?: string;
  messageCode?: string;
  message?: string;
}

export interface CashOrderCancellation {
  accepted: boolean;
  brokerOrderId?: string;
  orderTime?: string;
  messageCode?: string;
  message?: string;
}

/**
 * KIS 국내주식 현금 주문/취소 어댑터. 생성 시 고정한 target 환경과 클라이언트 환경이 다르면 어떤 요청도 보내지 않는다.
 * PAPER/LIVE 전용 서브클래스만 외부에 노출한다.
 */
export abstract class KISCashOrderAdapter {
  private readonly cano: string;
  private readonly accountProductCode: string;

  protected constructor(
    private readonly client: KISHttpClient,
    private readonly environment: KISEnvironment,
    cano: string,
    accountProductCode: string,
    protected readonly target: KISEnvironment,
  ) {
    this.cano = cano.trim();
    this.accountProductCode = accountProductCode.trim();
  }

  /** 네트워크 호출 없이 전송 가능 여부만 검증한다. 라우트가 SUBMITTING 기록 전에 호출한다 */
  assertSubmittable(request: CreateOrderRequest): void {
    this.assertAccount();
    assertOrderRequest(request);
    if (request.clientOrderId.startsWith('DRY-')) throw new Error(`DRY_RUN_ORDER_NOT_ALLOWED_ON_${this.target}`);
  }

  async submit(request: CreateOrderRequest): Promise<CashOrderSubmission> {
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
      tr_id: isBuy ? TR_IDS[this.target].buy : TR_IDS[this.target].sell,
      custtype: 'P',
    });

    const data = response.data;
    if (data.rt_cd !== '0') return { accepted: false, messageCode: data.msg_cd, message: data.msg1 };

    const brokerOrderId = data.output?.ODNO?.trim();
    if (!brokerOrderId) throw new Error(`${this.target}_ORDER_RESPONSE_MISSING_ORDER_ID`);
    const brokerOrderOrgNo = data.output?.KRX_FWDG_ORD_ORGNO?.trim();
    if (!brokerOrderOrgNo) throw new Error(`${this.target}_ORDER_RESPONSE_MISSING_ORDER_ORGNO`);
    return { accepted: true, brokerOrderId, brokerOrderOrgNo, orderTime: data.output?.ORD_TMD?.trim(), messageCode: data.msg_cd, message: data.msg1 };
  }

  async cancel(order: Order): Promise<CashOrderCancellation> {
    this.assertAccount();
    if (!order.brokerOrderId) throw new Error(`${this.target}_ORDER_BROKER_ID_REQUIRED`);
    if (!order.brokerOrderOrgNo) throw new Error(`${this.target}_ORDER_BROKER_ORGNO_REQUIRED`);

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
    }, { tr_id: TR_IDS[this.target].cancel, custtype: 'P' });

    const data = response.data;
    if (data.rt_cd !== '0') return { accepted: false, messageCode: data.msg_cd, message: data.msg1 };
    return { accepted: true, brokerOrderId: data.output?.ODNO?.trim(), orderTime: data.output?.ORD_TMD?.trim(), messageCode: data.msg_cd, message: data.msg1 };
  }

  private assertAccount(): void {
    if (this.environment !== this.target) throw new Error(`${this.target}_ORDER_REQUIRES_${this.target}_ENVIRONMENT`);
    validateAccountParts(this.cano, this.accountProductCode);
  }
}

/** 브로커 접수 결과를 상태 머신(SUBMITTING → SUBMITTED → ACCEPTED)을 거쳐 반영한다 */
export function toAcceptedOrder(order: Order, submission: CashOrderSubmission): Order {
  if (!submission.accepted || !submission.brokerOrderId) throw new Error('ORDER_NOT_ACCEPTED');
  const submitted = order.status === 'SUBMITTING' ? transitionOrder(order, 'SUBMITTED') : order;
  return transitionOrder(submitted, 'ACCEPTED', { brokerOrderId: submission.brokerOrderId, brokerOrderOrgNo: submission.brokerOrderOrgNo });
}
