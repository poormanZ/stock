import { describe, expect, it } from 'vitest';
import { isYyyymmdd, KISCandleAdapter, shiftYyyymmdd } from './kis-candle-adapter';

function row(date: string, close: number) {
  return { stck_bsop_date: date, stck_clpr: String(close), stck_oprc: String(close - 1), stck_hgpr: String(close + 1), stck_lwpr: String(close - 2), acml_vol: '10' };
}

describe('KISCandleAdapter', () => {
  it('validates and shifts YYYYMMDD dates', () => {
    expect(isYyyymmdd('20260231')).toBe(false);
    expect(isYyyymmdd('20260228')).toBe(true);
    expect(shiftYyyymmdd('20260301', -1)).toBe('20260228');
  });

  it('pages backwards through 100-row responses and returns ascending unique candles', async () => {
    const calls: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => row(shiftYyyymmdd('20260601', -i), 100 + i));
    const page2 = [row('20260101', 50), row('20260102', 51)];
    const client = {
      getJson: async (path: string) => {
        calls.push(path);
        return { rt_cd: '0', output2: calls.length === 1 ? page1 : page2 };
      },
    } as never;
    const candles = await new KISCandleAdapter(client).getDailyCandles('005930', '20260101', '20260601');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('FID_INPUT_DATE_2=20260601');
    expect(calls[1]).toContain(`FID_INPUT_DATE_2=${shiftYyyymmdd(shiftYyyymmdd('20260601', -99), -1)}`);
    expect(candles).toHaveLength(102);
    expect(candles[0]).toMatchObject({ date: '20260101', close: 50, open: 49 });
    expect(candles.at(-1)?.date).toBe('20260601');
  });

  it('rejects invalid ranges and KIS rejections', async () => {
    const client = { getJson: async () => ({ rt_cd: '1', msg1: 'nope' }) } as never;
    const adapter = new KISCandleAdapter(client);
    await expect(adapter.getDailyCandles('005930', '20260201', '20260101')).rejects.toThrow('INVALID_CANDLE_RANGE');
    await expect(adapter.getDailyCandles('005930', '20260101', '20260201')).rejects.toMatchObject({ code: 'KIS_UPSTREAM_ERROR' });
  });
});
