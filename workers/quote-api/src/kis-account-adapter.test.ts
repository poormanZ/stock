import { describe, expect, it } from 'vitest';
import { KISAccountAdapter } from './kis-account-adapter';
import type { KISJsonResponse } from './kis-http-client';

describe('KISAccountAdapter', () => {
  it('normalizes deposits and positions and follows continuation headers', async () => {
    const responses: Array<KISJsonResponse<Record<string, unknown>>> = [
      { data: { rt_cd: '0', output1: [{ pdno: '005930', prdt_name: '삼성전자', hldg_qty: '10', pchs_avg_pric: '70000', prpr: '75000', pchs_amt: '700000', evlu_amt: '750000', evlu_pfls_amt: '50000', evlu_pfls_rt: '7.14' }], output2: { dnca_tot_amt: '1000000', nxdy_excc_amt: '900000', prvs_rcdl_excc_amt: '800000', tot_evlu_amt: '1750000', nass_amt: '1750000' }, ctx_area_fk100: 'next-forward', ctx_area_nk100: 'next-key' }, headers: new Headers({ tr_cont: 'M' }) },
      { data: { rt_cd: '0', output1: [{ pdno: '000660', prdt_name: 'SK하이닉스', hldg_qty: '2', pchs_avg_pric: '100000', prpr: '120000', pchs_amt: '200000', evlu_amt: '240000', evlu_pfls_amt: '40000', evlu_pfls_rt: '20' }], output2: [{ dnca_tot_amt: '1000000', nxdy_excc_amt: '900000', prvs_rcdl_excc_amt: '800000', tot_evlu_amt: '1990000', nass_amt: '1990000' }] }, headers: new Headers({ tr_cont: 'D' }) },
    ];
    const calls: Array<Record<string, string>> = []; const client = { getJsonResponse: async <T>(_path: string, headers: Record<string, string>) => { calls.push(headers); return responses.shift() as unknown as KISJsonResponse<T>; } } as never;
    const adapter = new KISAccountAdapter(client, 'PAPER', '12345678', '01'); const snapshot = await adapter.getSnapshot();
    expect(snapshot.cash).toBe(1000000); expect(snapshot.totalEquity).toBe(1990000); expect(snapshot.source).toBe('stock-balance'); expect(snapshot.positions).toHaveLength(2); expect(snapshot.positions[0].symbol).toBe('005930'); expect(snapshot.positions[1].quantity).toBe(2); expect(calls[0].tr_cont).toBe(''); expect(calls[1].tr_cont).toBe('N');
  });

  it('calls the official account asset API separately', async () => {
    let requestedPath = ''; let requestedHeaders: Record<string, string> = {};
    const client = { getJsonResponse: async <T>(path: string, headers: Record<string, string>) => { requestedPath = path; requestedHeaders = headers; return { data: { rt_cd: '0', output1: [{ asset_type: 'CASH' }], output2: { sample_amount: '1000' } }, headers: new Headers() } as unknown as KISJsonResponse<T>; } } as never;
    const adapter = new KISAccountAdapter(client, 'LIVE', '12345678', '01'); const result = await adapter.getAccountAssets();
    expect(requestedPath).toContain('/uapi/domestic-stock/v1/trading/inquire-account-balance?'); expect(requestedPath).toContain('CANO=12345678'); expect(requestedPath).toContain('ACNT_PRDT_CD=01'); expect(requestedHeaders.tr_id).toBe('CTRP6548R'); expect(result.output1).toHaveLength(1); expect(result.output2.sample_amount).toBe('1000');
  });

  it('maps paper buyable amount response', async () => {
    let requestedPath = ''; let requestedHeaders: Record<string, string> = {};
    const client = { getJsonResponse: async <T>(path: string, headers: Record<string, string>) => { requestedPath = path; requestedHeaders = headers; return { data: { rt_cd: '0', output: { nrcvb_buy_amt: '9998235', max_buy_amt: '19996470', ord_psbl_cash: '9998235', nrcvb_buy_qty: '100', max_buy_qty: '200', psbl_qty_calc_unpr: '99999' } }, headers: new Headers() } as unknown as KISJsonResponse<T>; } } as never;
    const adapter = new KISAccountAdapter(client, 'PAPER', '12345678', '01'); const result = await adapter.getBuyable('005930', 99999, 'market');
    expect(requestedPath).toContain('/uapi/domestic-stock/v1/trading/inquire-psbl-order?'); expect(requestedPath).toContain('PDNO=005930'); expect(requestedPath).toContain('ORD_UNPR=99999'); expect(requestedPath).toContain('ORD_DVSN=01'); expect(requestedHeaders.tr_id).toBe('VTTC8908R'); expect(result.orderBuyableAmount).toBe(9998235); expect(result.maxBuyableAmount).toBe(19996470); expect(result.orderCash).toBe(9998235); expect(result.orderBuyableQuantity).toBe(100); expect(result.maxBuyableQuantity).toBe(200); expect(result.calculationPrice).toBe(99999);
  });

  it('uses live buyable TR ID for live accounts', async () => {
    let trId = ''; const client = { getJsonResponse: async <T>(_path: string, headers: Record<string, string>) => { trId = headers.tr_id; return { data: { rt_cd: '0', output: {} }, headers: new Headers() } as unknown as KISJsonResponse<T>; } } as never;
    const adapter = new KISAccountAdapter(client, 'LIVE', '12345678', '01'); await adapter.getBuyable('005930', 70000, 'limit'); expect(trId).toBe('TTTC8908R');
  });

  it('rejects malformed CANO and product code before calling KIS', async () => {
    const client = { getJsonResponse: async () => { throw new Error('must not call'); } } as never;
    await expect(new KISAccountAdapter(client, 'PAPER', '1234', '01').getSnapshot()).rejects.toThrow('CANO');
    await expect(new KISAccountAdapter(client, 'PAPER', '12345678', '1').getSnapshot()).rejects.toThrow('product code');
    await expect(new KISAccountAdapter(client, 'PAPER', '12345678', '21').getSnapshot()).rejects.toThrow('must be 01');
  });
});
