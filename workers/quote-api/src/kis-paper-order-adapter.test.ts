import { describe, expect, it, vi } from 'vitest';
import { KISPaperOrderAdapter } from './kis-paper-order-adapter';
import type { CreateOrderRequest } from './order-domain';

const request: CreateOrderRequest = {
  id: 'order-1',
  clientOrderId: 'client-1',
  symbol: '005930',
  side: 'buy',
  orderType: 'limit',
  quantity: 2,
  limitPrice: 70000,
};

function client(response: unknown) {
  return {
    postJsonResponse: vi.fn().mockResolvedValue({ data: response, headers: new Headers() }),
  } as never;
}

describe('KISPaperOrderAdapter', () => {
  it('uses PAPER buy TR and current order contract', async () => {
    const fakeClient = client({ rt_cd: '0', msg_cd: 'APBK0013', msg1: 'ok', output: { ODNO: '12345', ORD_TMD: '101500' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '12345678', '01');

    const result = await adapter.submit(request);

    expect(result).toMatchObject({ accepted: true, brokerOrderId: '12345', orderTime: '101500' });
    expect((fakeClient as any).postJsonResponse).toHaveBeenCalledWith(
      '/uapi/domestic-stock/v1/trading/order-cash',
      {
        CANO: '12345678',
        ACNT_PRDT_CD: '01',
        PDNO: '005930',
        ORD_DVSN: '00',
        ORD_QTY: '2',
        ORD_UNPR: '70000',
        EXCG_ID_DVSN_CD: 'KRX',
        SLL_TYPE: '',
        CNDT_PRIC: '',
      },
      { tr_id: 'VTTC0012U', custtype: 'P' },
    );
  });

  it('uses PAPER sell TR and market order fields', async () => {
    const fakeClient = client({ rt_cd: '0', output: { ODNO: '67890' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '12345678', '01');

    await adapter.submit({ ...request, side: 'sell', orderType: 'market', limitPrice: undefined });

    expect((fakeClient as any).postJsonResponse).toHaveBeenCalledWith(
      '/uapi/domestic-stock/v1/trading/order-cash',
      expect.objectContaining({ ORD_DVSN: '01', ORD_QTY: '2', ORD_UNPR: '0', SLL_TYPE: '01' }),
      { tr_id: 'VTTC0011U', custtype: 'P' },
    );
  });

  it('returns a business rejection without inventing a broker order id', async () => {
    const fakeClient = client({ rt_cd: '1', msg_cd: 'EGW00201', msg1: 'rejected' });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '12345678', '01');

    await expect(adapter.submit(request)).resolves.toEqual({
      accepted: false,
      messageCode: 'EGW00201',
      message: 'rejected',
    });
  });

  it('never submits through the adapter in LIVE environment', async () => {
    const fakeClient = client({ rt_cd: '0', output: { ODNO: '12345' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'LIVE', '12345678', '01');

    await expect(adapter.submit(request)).rejects.toThrow('PAPER_ORDER_REQUIRES_PAPER_ENVIRONMENT');
    expect((fakeClient as any).postJsonResponse).not.toHaveBeenCalled();
  });

  it('rejects invalid account configuration', async () => {
    const fakeClient = client({ rt_cd: '0', output: { ODNO: '12345' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '1234', '01');

    await expect(adapter.submit(request)).rejects.toThrow('KIS account CANO must use 8 digits');
  });
});
