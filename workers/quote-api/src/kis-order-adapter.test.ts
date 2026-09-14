import { describe, expect, it } from 'vitest';
import { KISOrderAdapter } from './kis-order-adapter';
import type { KISJsonResponse } from './kis-http-client';

describe('KISOrderAdapter', () => {
  it('normalizes order history and uses live order-history TR ID', async () => {
    let requestedPath = '';
    let requestedHeaders: Record<string, string> = {};
    const client = {
      getJsonResponse: async <T>(path: string, headers: Record<string, string>) => {
        requestedPath = path;
        requestedHeaders = headers;
        return {
          data: {
            rt_cd: '0',
            output1: [
              { ord_dt: '20260914', odno: '12345', orgn_odno: '', pdno: '005930', prdt_name: '삼성전자', sll_buy_dvsn_cd: '02', ord_dvsn_cd: '00', ord_qty: '2', ord_unpr: '70000', tot_ccld_qty: '2', avg_prvs: '70100', rjct_yn: 'N', cncl_yn: 'N', ord_tmd: '101530' },
            ],
          },
          headers: new Headers(),
        } as unknown as KISJsonResponse<T>;
      },
    } as never;
    const adapter = new KISOrderAdapter(client, 'LIVE', '12345678', '01');
    const result = await adapter.getOrderHistory('20260914', '20260914');
    expect(requestedPath).toContain('/uapi/domestic-stock/v1/trading/inquire-daily-ccld?');
    expect(requestedPath).toContain('INQR_STRT_DT=20260914');
    expect(requestedPath).toContain('INQR_END_DT=20260914');
    expect(requestedHeaders.tr_id).toBe('TTTC0081R');
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].brokerOrderId).toBe('12345');
    expect(result.orders[0].side).toBe('buy');
    expect(result.orders[0].orderType).toBe('limit');
    expect(result.orders[0].status).toBe('FILLED');
    expect(result.orders[0].executedQuantity).toBe(2);
  });

  it('uses paper order-history TR ID and validates dates', async () => {
    let trId = '';
    const client = {
      getJsonResponse: async <T>(_path: string, headers: Record<string, string>) => {
        trId = headers.tr_id;
        return { data: { rt_cd: '0', output1: [] }, headers: new Headers() } as unknown as KISJsonResponse<T>;
      },
    } as never;
    const adapter = new KISOrderAdapter(client, 'PAPER', '12345678', '01');
    await adapter.getOrderHistory('20260913', '20260914');
    expect(trId).toBe('VTTC0081R');
    await expect(adapter.getOrderHistory('20260915', '20260914')).rejects.toThrow('start date');
    await expect(adapter.getOrderHistory('2026091', '20260914')).rejects.toThrow('YYYYMMDD');
  });
});
