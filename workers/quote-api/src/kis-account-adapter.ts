import type { KISEnvironment, KISPaged, KISResponseMeta } from './kis-common';
import { assertAccepted, forEachKisPage, toNumber, validateAccountParts } from './kis-common';
import type { KISHttpClient } from './kis-http-client';

type RawBalanceItem = Record<string, string | number | undefined>;
type RawBalanceResponse = KISResponseMeta & KISPaged & {
  output1?: RawBalanceItem[];
  output2?: RawBalanceItem[] | RawBalanceItem;
};
type RawAccountAssetResponse = KISResponseMeta & {
  output1?: RawBalanceItem[];
  output2?: RawBalanceItem;
};
type RawBuyableResponse = KISResponseMeta & { output?: RawBalanceItem };

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
  environment: KISEnvironment;
  source: 'stock-balance' | 'account-balance';
  cash: number;
  settlementD1Cash: number;
  settlementD2Cash: number;
  totalEquity: number;
  netAssetValue: number;
  positions: AccountPosition[];
}

export interface AccountAssetSnapshot {
  asOf: string;
  environment: KISEnvironment;
  canoConfigured: boolean;
  productCodeConfigured: boolean;
  output1: RawBalanceItem[];
  output2: RawBalanceItem;
}

export interface BuyableOrder {
  asOf: string;
  environment: KISEnvironment;
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
const ACCOUNT_ASSET_PATH = '/uapi/domestic-stock/v1/trading/inquire-account-balance';
const BUYABLE_PATH = '/uapi/domestic-stock/v1/trading/inquire-psbl-order';
const BALANCE_TR_ID: Record<KISEnvironment, string> = { LIVE: 'TTTC8434R', PAPER: 'VTTC8434R' };
const BUYABLE_TR_ID: Record<KISEnvironment, string> = { LIVE: 'TTTC8908R', PAPER: 'VTTC8908R' };
const ACCOUNT_ASSET_TR_ID = 'CTRP6548R';
const QUERY_HEADERS = { 'content-type': 'application/json; charset=utf-8', custtype: 'P' };

function firstObject(value: RawBalanceResponse['output2']): RawBalanceItem {
  return Array.isArray(value) ? value[0] ?? {} : value ?? {};
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

export class KISAccountAdapter {
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

  async getAccountAssets(): Promise<AccountAssetSnapshot> {
    validateAccountParts(this.cano, this.accountProductCode);
    const query = new URLSearchParams({ CANO: this.cano, ACNT_PRDT_CD: this.accountProductCode, INQR_DVSN_1: '', BSPR_BF_DT_APLY_YN: '' });
    const response = await this.client.getJsonResponse<RawAccountAssetResponse>(`${ACCOUNT_ASSET_PATH}?${query}`, {
      ...QUERY_HEADERS,
      tr_id: ACCOUNT_ASSET_TR_ID,
    });
    assertAccepted('account asset', response.data);
    return {
      asOf: new Date().toISOString(),
      environment: this.environment,
      canoConfigured: true,
      productCodeConfigured: true,
      output1: response.data.output1 ?? [],
      output2: response.data.output2 ?? {},
    };
  }

  async getSnapshot(): Promise<AccountSnapshot> {
    validateAccountParts(this.cano, this.accountProductCode);
    const positions: AccountPosition[] = [];
    let summary: RawBalanceItem = {};

    await forEachKisPage<RawBalanceResponse>('balance', (cursor) => {
      const query = new URLSearchParams({
        CANO: this.cano,
        ACNT_PRDT_CD: this.accountProductCode,
        AFHR_FLPR_YN: 'N',
        OFL_YN: '',
        INQR_DVSN: '01',
        UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N',
        FNCG_AMT_AUTO_RDPT_YN: 'N',
        PRCS_DVSN: '00',
        CTX_AREA_FK100: cursor.CTX_AREA_FK100,
        CTX_AREA_NK100: cursor.CTX_AREA_NK100,
      });
      return this.client.getJsonResponse<RawBalanceResponse>(`${BALANCE_PATH}?${query}`, {
        ...QUERY_HEADERS,
        tr_id: BALANCE_TR_ID[this.environment],
        tr_cont: cursor.tr_cont,
      });
    }, (data) => {
      for (const item of data.output1 ?? []) {
        const position = normalizePosition(item);
        if (position) positions.push(position);
      }
      summary = firstObject(data.output2);
    });

    return {
      asOf: new Date().toISOString(),
      environment: this.environment,
      source: 'stock-balance',
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
    validateAccountParts(this.cano, this.accountProductCode);

    const price = Math.trunc(orderPrice);
    const query = new URLSearchParams({
      CANO: this.cano,
      ACNT_PRDT_CD: this.accountProductCode,
      PDNO: symbol,
      ORD_UNPR: String(price),
      ORD_DVSN: orderType === 'market' ? '01' : '00',
      CMA_EVLU_AMT_ICLD_YN: 'N',
      OVRS_ICLD_YN: 'N',
    });
    const response = await this.client.getJsonResponse<RawBuyableResponse>(`${BUYABLE_PATH}?${query}`, {
      ...QUERY_HEADERS,
      tr_id: BUYABLE_TR_ID[this.environment],
    });
    assertAccepted('buyable', response.data);
    const output = response.data.output ?? {};
    return {
      asOf: new Date().toISOString(),
      environment: this.environment,
      symbol,
      orderType,
      orderPrice: price,
      orderBuyableAmount: toNumber(output.nrcvb_buy_amt),
      maxBuyableAmount: toNumber(output.max_buy_amt),
      orderCash: toNumber(output.ord_psbl_cash),
      orderBuyableQuantity: toNumber(output.nrcvb_buy_qty),
      maxBuyableQuantity: toNumber(output.max_buy_qty),
      calculationPrice: toNumber(output.psbl_qty_calc_unpr) || price,
    };
  }
}
