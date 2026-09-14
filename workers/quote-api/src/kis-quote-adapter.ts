import { KISHttpClient, KISHttpError } from './kis-http-client';

export const QUOTE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-price';
export const QUOTE_TR_ID = 'FHKST01010100';

export type StockQuote = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  asOf: string;
  market: 'KRX';
  source: 'KIS OPEN API';
  delayed: boolean;
};

type KISQuoteResponse = {
  rt_cd?: string;
  msg1?: string;
  output?: {
    stck_prpr?: string;
    prdy_vrss?: string;
    prdy_ctrt?: string;
    acml_vol?: string;
    stck_bsop_date?: string;
    stck_cntg_hour?: string;
  };
};

function toNumber(value?: string): number {
  const parsed = Number(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

export class KISQuoteAdapter {
  constructor(private readonly client: KISHttpClient) {}

  async getQuote(symbol: string): Promise<StockQuote> {
    if (!/^\d{6}$/.test(symbol)) {
      throw new KISHttpError('KIS_INVALID_RESPONSE', 'Invalid domestic stock symbol');
    }

    const body = await this.client.getJson<KISQuoteResponse>(QUOTE_PATH, {
      appkey: this.clientAppKey,
      appsecret: this.clientAppSecret,
      tr_id: QUOTE_TR_ID,
      custtype: 'P',
    });

    if (body.rt_cd && body.rt_cd !== '0') {
      throw new KISHttpError('KIS_UPSTREAM_ERROR', body.msg1 || 'KIS quote request was rejected');
    }

    const output = body.output;
    if (!output?.stck_prpr) {
      throw new KISHttpError('KIS_INVALID_RESPONSE', 'KIS quote response did not contain a price');
    }

    return {
      symbol,
      price: toNumber(output.stck_prpr),
      change: toNumber(output.prdy_vrss),
      changePercent: toNumber(output.prdy_ctrt),
      volume: toNumber(output.acml_vol),
      asOf: [output.stck_bsop_date, output.stck_cntg_hour].filter(Boolean).join(' '),
      market: 'KRX',
      source: 'KIS OPEN API',
      delayed: false,
    };
  }

  private get clientAppKey(): string {
    return this.clientCredentials.appKey;
  }

  private get clientAppSecret(): string {
    return this.clientCredentials.appSecret;
  }

  private get clientCredentials(): { appKey: string; appSecret: string } {
    return this.client as unknown as { appKey: string; appSecret: string };
  }
}
