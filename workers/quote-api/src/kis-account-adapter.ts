import { KISHttpClient } from './kis-http-client';

type RawBalanceItem = Record<string, string | number | undefined>;
type RawBalanceResponse = {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
  output1?: RawBalanceItem[];
  output2?: RawBalanceItem[] | RawBalanceItem;
  ctx_area_fk100?: string;
  ctx_area_nk100?: string;
};

type RawBuyableResponse = {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
  output?: RawBalanceItem;
};

export interface AccountPosition {
  symbol: string;
  name: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  purchaseAmount: number;
  evaluationAmount: number;
  profitLossAmount: number;
  profitLossPercent: number;
}

export interface AccountSnapshot {
  asOf: string;
  environment: 'PAPER' | 'LIVE';
  cash: number;
  settlementD1Cash: number;
  settlementD2Cash: number;
  totalEquity: number;
  netAssetValue: number;
  positions: AccountPosition[];
}

export interface BuyableOrder {
  asOf: string;
  environment: 'PAPER' | 'LIVE';
  symbol: string;
  orderType: 'market' | 'limit';
  orderPrice: number;
  orderBuyableAmount: number;
  maxBuyableAmount: number;
  orderCash: number;
  orderBuyableQuantity: number;
  maxBuyableQuantity: number;
  calculationPrice: number;
}

const BALANCE_PATH = '/uapi/domestic-stock/v1/trading/inquire-balance';
const BUYABLE_PATH = '/uapi/domestic-stock/v1/trading/inquire-psbl-order';
const LIVE_TR_ID = 'TTTC8434R';
const PAPER_TR_ID = 'VTTC8434R';
const LIVE_BUYABLE_TR_ID = 'TTTC8908R';
const PAPER_BUYABLE_TR_ID = 'VTTC8908R';
const MAX_PAGES = 20;

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstObject(value: RawBalanceResponse['output2']): RawBalanceItem {
  if (Array.isArray(value)) return value[0] ?? {};
  return value ?? {};
}

function normalizePosition(item: RawBalanceItem): AccountPosition | null {
  const symbol = String(item.pdno ?? '').trim();
  const quantity = toNumber(item.hldg_qty);
  if (!/^\d{6}$/.test(symbol) || quantity <= 0) return null;

  return {
    symbol,
    name: String(item.prdt_name ?? '').trim(),
    quantity,
    averagePrice: toNumber(item.pchs_avg_pric),
    currentPrice: toNumber(item.prpr),
    purchaseAmount: toNumber(item.pchs_amt),
    evaluationAmount: toNumber(item.evlu_amt),
    profitLossAmount: toNumber(item.evlu_pfls_amt),
    profitLossPercent: toNumber(item.evlu_pfls_rt),
  };
}

function validateAccountParts(cano: string, accountProductCode: string): void {
  if (!/^\d{8}$/.test(cano.trim())) {
    throw new Error('KIS account CANO must use 8 digits');
  }
  if (!/^\d{2}$/.test(accountProductCode.trim())) {
    throw new Error('KIS account product code must use 2 digits');
  }
}

export class KISAccountAdapter {
  constructor(
    private readonly client: KISHttpClient,
    private readonly environment: 'PAPER' | 'LIVE',
    private readonly cano: string,
    private readonly accountProductCode: string,
  ) {}

  async getSnapshot(): Promise<AccountSnapshot> {
    const cano = this.cano.trim();
    const accountProductCode = this.accountProductCode.trim();
    validateAccountParts(cano, accountProductCode);

    const trId = this.environment === 'LIVE' ? LIVE_TR_ID : PAPER_TR_ID;
    const positions: AccountPosition[] = [];
    let contextForward = '';
    let contextNext = '';
    let continuation = '';
    let summary: RawBalanceItem = {};
    let pages = 0;

    while (pages < MAX_PAGES) {
      const query = new URLSearchParams({
        CANO: cano,
        ACNT_PRDT_CD: accountProductCode,
        AFHR_FLPR_YN: 'N',
        OFL_YN: '',
        INQR_DVSN: '01',
        UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N',
        FNCG_AMT_AUTO_RDPT_YN: 'N',
        PRCS_DVSN: '00',
        CTX_AREA_FK100: contextForward,
        CTX_AREA_NK100: contextNext,
      });

      const response = await this.client.getJsonResponse<RawBalanceResponse>(
        `${BALANCE_PATH}?${query.toString()}`,
        {
          'content-type': 'application/json; charset=utf-8',
          tr_id: trId,
          custtype: 'P',
          tr_cont: continuation,
        },
      );

      if (response.data.rt_cd && response.data.rt_cd !== '0') {
        throw new Error(`KIS balance request failed: ${response.data.msg_cd ?? 'UNKNOWN'}`);
      }

      for (const item of response.data.output1 ?? []) {
        const position = normalizePosition(item);
        if (position) positions.push(position);
      }

      summary = firstObject(response.data.output2);
      contextForward = String(response.data.ctx_area_fk100 ?? '');
      contextNext = String(response.data.ctx_area_nk100 ?? '');
      const next = response.headers.get('tr_cont') ?? '';
      if (next !== 'F' && next !== 'M') break;

      continuation = 'N';
      pages += 1;
    }

    if (pages >= MAX_PAGES) throw new Error('KIS balance pagination limit exceeded');

    return {
      asOf: new Date().toISOString(),
      environment: this.environment,
      cash: toNumber(summary.dnca_tot_amt),
      settlementD1Cash: toNumber(summary.nxdy_excc_amt),
      settlementD2Cash: toNumber(summary.prvs_rcdl_excc_amt),
      totalEquity: toNumber(summary.tot_evlu_amt),
      netAssetValue: toNumber(summary.nass_amt),
      positions,
    };
  }

  async getBuyable(symbol: string, orderPrice: number, orderType: 'market' | 'limit' = 'market'): Promise<BuyableOrder> {
    if (!/^\d{6}$/.test(symbol)) throw new Error('KIS stock symbol must use 6 digits');
    if (!Number.isFinite(orderPrice) || orderPrice <= 0) throw new Error('KIS order price must be positive');

    const cano = this.cano.trim();
    const accountProductCode = this.accountProductCode.trim();
    validateAccountParts(cano, accountProductCode);

    const trId = this.environment === 'LIVE' ? LIVE_BUYABLE_TR_ID : PAPER_BUYABLE_TR_ID;
    const query = new URLSearchParams({
      CANO: cano,
      ACNT_PRDT_CD: accountProductCode,
      PDNO: symbol,
      ORD_UNPR: String(Math.trunc(orderPrice)),
      ORD_DVSN: orderType === 'market' ? '01' : '00',
      CMA_EVLU_AMT_ICLD_YN: 'N',
      OVRS_ICLD_YN: 'N',
    });

    const response = await this.client.getJsonResponse<RawBuyableResponse>(
      `${BUYABLE_PATH}?${query.toString()}`,
      {
        'content-type': 'application/json; charset=utf-8',
        tr_id: trId,
        custtype: 'P',
      },
    );

    if (response.data.rt_cd && response.data.rt_cd !== '0') {
      throw new Error(`KIS buyable request failed: ${response.data.msg_cd ?? 'UNKNOWN'}`);
    }

    const output = response.data.output ?? {};
    return {
      asOf: new Date().toISOString(),
      environment: this.environment,
      symbol,
      orderType,
      orderPrice: Math.trunc(orderPrice),
      orderBuyableAmount: toNumber(output.nrcvb_buy_amt),
      maxBuyableAmount: toNumber(output.max_buy_amt),
      orderCash: toNumber(output.ord_psbl_cash),
      orderBuyableQuantity: toNumber(output.nrcvb_buy_qty),
      maxBuyableQuantity: toNumber(output.max_buy_qty),
      calculationPrice: toNumber(output.psbl_qty_calc_unpr) || Math.trunc(orderPrice),
    };
  }
}
