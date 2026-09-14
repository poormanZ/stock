import { KISHttpClient } from './kis-http-client';

type RawOrderItem = Record<string, string | number | undefined>;
type RawOrderResponse = {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
  output1?: RawOrderItem[];
  ctx_area_fk100?: string;
  ctx_area_nk100?: string;
};

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
  environment: 'PAPER' | 'LIVE';
  startDate: string;
  endDate: string;
  orders: OrderRecord[];
}

const ORDER_HISTORY_PATH = '/uapi/domestic-stock/v1/trading/inquire-daily-ccld';
const LIVE_TR_ID = 'TTTC0081R';
const PAPER_TR_ID = 'VTTC0081R';
const MAX_PAGES = 20;

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function validateAccountParts(cano: string, accountProductCode: string): void {
  if (!/^\d{8}$/.test(cano.trim())) throw new Error('KIS account CANO must use 8 digits');
  if (accountProductCode.trim() !== '01') throw new Error('KIS consignment account product code must be 01');
}

function validateDate(value: string, name: string): void {
  if (!/^\d{8}$/.test(value) || Number.isNaN(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))))) {
    throw new Error(`KIS ${name} must use YYYYMMDD`);
  }
}

function todayKst(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
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
  const side = sideCode === '02' ? 'buy' : sideCode === '01' ? 'sell' : 'unknown';
  const orderTypeCode = String(item.ord_dvsn_cd ?? '').trim();
  const orderType = orderTypeCode === '01' ? 'market' : orderTypeCode === '00' ? 'limit' : 'other';

  return {
    brokerOrderId: String(item.odno ?? '').trim(),
    originalOrderId: String(item.orgn_odno ?? '').trim(),
    orderDate: String(item.ord_dt ?? '').trim(),
    symbol: String(item.pdno ?? '').trim(),
    name: String(item.prdt_name ?? '').trim(),
    side,
    orderType,
    quantity: orderQty,
    orderPrice: toNumber(item.ord_unpr),
    executedQuantity,
    averageExecutedPrice: toNumber(item.avg_prvs),
    status,
    orderTime: String(item.ord_tmd ?? '').trim(),
  };
}

function kisRequestError(response: { msg_cd?: string; msg1?: string }): Error {
  const code = response.msg_cd ?? 'UNKNOWN';
  const message = response.msg1?.trim();
  return new Error(`KIS order history request failed: ${code}${message ? ` - ${message}` : ''}`);
}

export class KISOrderAdapter {
  constructor(private readonly client: KISHttpClient, private readonly environment: 'PAPER' | 'LIVE', private readonly cano: string, private readonly accountProductCode: string) {}

  async getOrderHistory(startDate = todayKst(), endDate = todayKst()): Promise<OrderHistorySnapshot> {
    const cano = this.cano.trim();
    const accountProductCode = this.accountProductCode.trim();
    validateAccountParts(cano, accountProductCode);
    validateDate(startDate, 'start date');
    validateDate(endDate, 'end date');
    if (startDate > endDate) throw new Error('KIS order history start date must not be after end date');

    const trId = this.environment === 'LIVE' ? LIVE_TR_ID : PAPER_TR_ID;
    const orders: OrderRecord[] = [];
    let contextForward = '';
    let contextNext = '';
    let continuation = '';
    let pages = 0;

    while (pages < MAX_PAGES) {
      const query = new URLSearchParams({
        CANO: cano,
        ACNT_PRDT_CD: accountProductCode,
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
        CTX_AREA_FK100: contextForward,
        CTX_AREA_NK100: contextNext,
      });
      const response = await this.client.getJsonResponse<RawOrderResponse>(`${ORDER_HISTORY_PATH}?${query.toString()}`, {
        'content-type': 'application/json; charset=utf-8',
        tr_id: trId,
        custtype: 'P',
        tr_cont: continuation,
      });
      if (response.data.rt_cd && response.data.rt_cd !== '0') throw kisRequestError(response.data);
      for (const item of response.data.output1 ?? []) orders.push(normalizeOrder(item));
      contextForward = String(response.data.ctx_area_fk100 ?? '');
      contextNext = String(response.data.ctx_area_nk100 ?? '');
      const next = response.headers.get('tr_cont') ?? '';
      if (next !== 'F' && next !== 'M') break;
      continuation = 'N';
      pages += 1;
    }
    if (pages >= MAX_PAGES) throw new Error('KIS order history pagination limit exceeded');
    return { asOf: new Date().toISOString(), environment: this.environment, startDate, endDate, orders };
  }
}
