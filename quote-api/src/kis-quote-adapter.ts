import { kisTimestampToIso, toNumber, type KISResponseMeta } from './kis-common';
import { KISHttpClient, KISHttpError } from './kis-http-client';

export const QUOTE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-price';
export const QUOTE_TR_ID = 'FHKST01010100';

export type StockQuote = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  /** KIS 마지막 체결시각("YYYYMMDD HHMMSS", KST). 현재가 API가 시각을 주지 않으면 빈 문자열 */
  asOf: string;
  /** Worker가 KIS로부터 시세를 수신한 시각(ISO 8601) */
  fetchedAt: string;
  market: 'KRX';
  source: 'KIS OPEN API';
  delayed: boolean;
};

type KISQuoteResponse = KISResponseMeta & {
  output?: {
    stck_prpr?: string;
    prdy_vrss?: string;
    prdy_ctrt?: string;
    acml_vol?: string;
    stck_bsop_date?: string;
    stck_cntg_hour?: string;
  };
};

/** 주문 판단용 시세 기준 시각: KIS 체결시각이 있으면 우선, 없으면 수신 시각 */
export function quoteReferenceTime(quote: Pick<StockQuote, 'asOf' | 'fetchedAt'>): string {
  return kisTimestampToIso(quote.asOf) ?? quote.fetchedAt;
}

export class KISQuoteAdapter {
  constructor(private readonly client: KISHttpClient) {}

  async getQuote(symbol: string): Promise<StockQuote> {
    if (!/^\d{6}$/.test(symbol)) {
      throw new KISHttpError('KIS_INVALID_RESPONSE', 'Invalid domestic stock symbol');
    }

    const query = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol });
    const body = await this.client.getJson<KISQuoteResponse>(`${QUOTE_PATH}?${query}`, { tr_id: QUOTE_TR_ID, custtype: 'P' });
    const fetchedAt = new Date().toISOString();

    if (body.rt_cd !== '0') {
      throw new KISHttpError('KIS_UPSTREAM_ERROR', body.msg1 || 'KIS quote request was rejected', undefined, body.msg_cd);
    }

    const output = body.output;
    const price = toNumber(output?.stck_prpr);
    if (!output?.stck_prpr || price <= 0) {
      throw new KISHttpError('KIS_INVALID_RESPONSE', 'KIS quote response did not contain a price');
    }

    return {
      symbol,
      price,
      change: toNumber(output.prdy_vrss),
      changePercent: toNumber(output.prdy_ctrt),
      volume: toNumber(output.acml_vol),
      asOf: [output.stck_bsop_date, output.stck_cntg_hour].filter(Boolean).join(' '),
      fetchedAt,
      market: 'KRX',
      source: 'KIS OPEN API',
      delayed: false,
    };
  }
}
