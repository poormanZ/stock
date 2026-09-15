import { toNumber, type KISResponseMeta } from './kis-common';
import { KISHttpClient, KISHttpError } from './kis-http-client';
import type { Candle } from './strategy';

export const CANDLE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice';
export const CANDLE_TR_ID = 'FHKST03010100';
/** KIS 기간별시세는 한 번에 최대 100건을 돌려준다 */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

type RawCandle = Record<string, string | undefined>;
type KISCandleResponse = KISResponseMeta & { output2?: RawCandle[] };

export function isYyyymmdd(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10).replace(/-/g, '') === value;
}

export function shiftYyyymmdd(value: string, days: number): string {
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)) + days));
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function normalizeCandle(item: RawCandle): Candle | null {
  const date = String(item.stck_bsop_date ?? '').trim();
  const close = toNumber(item.stck_clpr);
  if (!isYyyymmdd(date) || close <= 0) return null;
  return {
    date,
    open: toNumber(item.stck_oprc) || close,
    high: toNumber(item.stck_hgpr) || close,
    low: toNumber(item.stck_lwpr) || close,
    close,
    volume: toNumber(item.acml_vol),
  };
}

export class KISCandleAdapter {
  constructor(private readonly client: KISHttpClient) {}

  /** 일봉을 오래된 순으로 반환한다. 100건 단위로 종료일을 앞당기며 조회한다 */
  async getDailyCandles(symbol: string, startDate: string, endDate: string): Promise<Candle[]> {
    if (!/^\d{6}$/.test(symbol)) throw new KISHttpError('KIS_INVALID_RESPONSE', 'Invalid domestic stock symbol');
    if (!isYyyymmdd(startDate) || !isYyyymmdd(endDate) || startDate > endDate) throw new Error('INVALID_CANDLE_RANGE');

    const byDate = new Map<string, Candle>();
    let windowEnd = endDate;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: startDate,
        FID_INPUT_DATE_2: windowEnd,
        FID_PERIOD_DIV_CODE: 'D',
        FID_ORG_ADJ_PRC: '0',
      });
      const body = await this.client.getJson<KISCandleResponse>(`${CANDLE_PATH}?${query}`, { tr_id: CANDLE_TR_ID, custtype: 'P' });
      if (body.rt_cd !== '0') throw new KISHttpError('KIS_UPSTREAM_ERROR', body.msg1 || 'KIS candle request was rejected', undefined, body.msg_cd);

      const rows = (body.output2 ?? []).map(normalizeCandle).filter((candle): candle is Candle => candle !== null);
      for (const candle of rows) if (candle.date >= startDate && candle.date <= endDate) byDate.set(candle.date, candle);
      if (rows.length < PAGE_SIZE) break;
      const oldest = rows.reduce((min, candle) => (candle.date < min ? candle.date : min), rows[0].date);
      if (oldest <= startDate) break;
      windowEnd = shiftYyyymmdd(oldest, -1);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}
