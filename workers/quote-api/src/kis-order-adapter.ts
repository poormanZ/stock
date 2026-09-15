import type { KISEnvironment, KISPaged, KISResponseMeta } from './kis-common';
import { forEachKisPage, todayKst, toNumber, validateAccountParts } from './kis-common';
import type { KISHttpClient } from './kis-http-client';

type RawOrderItem = Record<string, string | number | undefined>;
type RawOrderResponse = KISResponseMeta & KISPaged & { output1?: RawOrderItem[] };

export interface OrderRecord {
  brokerOrderId: string;
  originalOrderId: string;
  orderDate: string;
  symbol: string;
  name: string;
  side: 'buy' | 'sell' | 'unknown';
  orderType: 'market' | 'limit' | 'other';
  quantity: number;
  orderPrice: number;
  executedQuantity: number;
  averageExecutedPrice: number;
  status: 'ACCEPTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'UNKNOWN';
  orderTime: string;
}

export interface OrderHistorySnapshot {
  asOf: string;
  environment: KISEnvironment;
  startDate: string;
  endDate: string;
  orders: OrderRecord[];
}

const ORDER_HISTORY_PATH = '/uapi/domestic-stock/v1/trading/inquire-daily-ccld';
const ORDER_HISTORY_TR_ID: Record<KISEnvironment, string> = { LIVE: 'TTTC0081R', PAPER: 'VTTC0081R' };

function validateDate(value: string, name: string): void {
  const valid = /^\d{8}$/.test(value)
    && !Number.isNaN(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
  if (!valid) throw new Error(`KIS ${name} must use YYYYMMDD`);
}

function normalizeOrder(item: RawOrderItem): OrderRecord {
  const orderQty = toNumber(item.ord_qty);
  const executedQuantity = toNumber(item.tot_ccld_qty);
  const rejected = String(item.rjct_yn ?? '').trim().toUpperCase() === 'Y';
  const canceled = String(item.cncl_yn ?? '').trim().toUpperCase() === 'Y';
  let status: OrderRecord['status'] = 'ACCEPTED';
  if (rejected) status = 'REJECTED';
  else if (canceled) status = 'CANCELED';
  else if (executedQuantity > 0 && orderQty > 0 && executedQuantity >= orderQty) status = 'FILLED';
  else if (executedQuantity > 0) status = 'PARTIALLY_FILLED';

  const sideCode = String(item.sll_buy_dvsn_cd ?? '').trim();
  const orderTypeCode = String(item.ord_dvsn_cd ?? '').trim();

  return {
    brokerOrderId: String(item.odno ?? '').trim(),
    originalOrderId: String(item.orgn_odno ?? '').trim(),
    orderDate: String(item.ord_dt ?? '').trim(),
    symbol: String(item.pdno ?? '').trim(),
    name: String(item.prdt_name ?? '').trim(),
    side: sideCode === '02' ? 'buy' : sideCode === '01' ? 'sell' : 'unknown',
    orderType: orderTypeCode === '01' ? 'market' : orderTypeCode === '00' ? 'limit' : 'other',
    quantity: orderQty,
    orderPrice: toNumber(item.ord_unpr),
    executedQuantity,
    averageExecutedPrice: toNumber(item.avg_prvs),
    status,
    orderTime: String(item.ord_tmd ?? '').trim(),
  };
}

export class KISOrderAdapter {
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

  async getOrderHistory(startDate = todayKst(), endDate = todayKst()): Promise<OrderHistorySnapshot> {
    validateAccountParts(this.cano, this.accountProductCode);
    validateDate(startDate, 'start date');
    validateDate(endDate, 'end date');
    if (startDate > endDate) throw new Error('KIS order history start date must not be after end date');

    const orders: OrderRecord[] = [];
    await forEachKisPage<RawOrderResponse>('order history', (cursor) => {
      const query = new URLSearchParams({
        CANO: this.cano,
        ACNT_PRDT_CD: this.accountProductCode,
        INQR_STRT_DT: startDate,
        INQR_END_DT: endDate,
        SLL_BUY_DVSN_CD: '00',
        INQR_DVSN: '00',
        PDNO: '',
        CCLD_DVSN: '00',
        ORD_GNO_BRNO: '',
        ODNO: '',
        INQR_DVSN_3: '00',
        INQR_DVSN_1: '',
        CTX_AREA_FK100: cursor.CTX_AREA_FK100,
        CTX_AREA_NK100: cursor.CTX_AREA_NK100,
      });
      return this.client.getJsonResponse<RawOrderResponse>(`${ORDER_HISTORY_PATH}?${query}`, {
        'content-type': 'application/json; charset=utf-8',
        tr_id: ORDER_HISTORY_TR_ID[this.environment],
        custtype: 'P',
        tr_cont: cursor.tr_cont,
      });
    }, (data) => {
      for (const item of data.output1 ?? []) orders.push(normalizeOrder(item));
    });

    return { asOf: new Date().toISOString(), environment: this.environment, startDate, endDate, orders };
  }
}
