import { describe, expect, it } from 'vitest';
import { KISAccountAdapter } from './kis-account-adapter';
import type { KISJsonResponse } from './kis-http-client';

describe('KISAccountAdapter', () => {
  it('normalizes deposits and positions and follows continuation headers', async () => {
    const responses: Array<KISJsonResponse<Record<string, unknown>>> = [
      {
        data: {
          rt_cd: '0',
          output1: [
            {
              pdno: '005930',
              prdt_name: '삼성전자',
              hldg_qty: '10',
              pchs_avg_pric: '70000',
              prpr: '75000',
              pchs_amt: '700000',
              evlu_amt: '750000',
              evlu_pfls_amt: '50000',
              evlu_pfls_rt: '7.14',
            },
          ],
          output2: {
            dnca_tot_amt: '1000000',
            nxdy_excc_amt: '900000',
            prvs_rcdl_excc_amt: '800000',
            tot_evlu_amt: '1750000',
            nass_amt: '1750000',
          },
          ctx_area_fk100: 'next-forward',
          ctx_area_nk100: 'next-key',
        },
        headers: new Headers({ tr_cont: 'M' }),
      },
      {
        data: {
          rt_cd: '0',
          output1: [
            {
              pdno: '000660',
              prdt_name: 'SK하이닉스',
              hldg_qty: '2',
              pchs_avg_pric: '100000',
              prpr: '120000',
              pchs_amt: '200000',
              evlu_amt: '240000',
              evlu_pfls_amt: '40000',
              evlu_pfls_rt: '20',
            },
          ],
          output2: [{
            dnca_tot_amt: '1000000',
            nxdy_excc_amt: '900000',
            prvs_rcdl_excc_amt: '800000',
            tot_evlu_amt: '1990000',
            nass_amt: '1990000',
          }],
        },
        headers: new Headers({ tr_cont: 'D' }),
      },
    ];

    const calls: Array<Record<string, string>> = [];
    const client = {
      getJsonResponse: async <T>(_path: string, headers: Record<string, string>) => {
        calls.push(headers);
        return responses.shift() as unknown as KISJsonResponse<T>;
      },
    } as never;

    const adapter = new KISAccountAdapter(client, 'PAPER', '12345678-01');
    const snapshot = await adapter.getSnapshot();

    expect(snapshot.cash).toBe(1000000);
    expect(snapshot.totalEquity).toBe(1990000);
    expect(snapshot.positions).toHaveLength(2);
    expect(snapshot.positions[0].symbol).toBe('005930');
    expect(snapshot.positions[1].quantity).toBe(2);
    expect(calls[0].tr_cont).toBe('');
    expect(calls[1].tr_cont).toBe('N');
  });

  it('rejects malformed account numbers before calling KIS', async () => {
    const client = { getJsonResponse: async () => { throw new Error('must not call'); } } as never;
    const adapter = new KISAccountAdapter(client, 'PAPER', '1234');

    await expect(adapter.getSnapshot()).rejects.toThrow('8-2 format');
  });
});
