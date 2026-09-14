import { describe, expect, it, vi } from 'vitest';
import { KISPaperOrderAdapter } from './kis-paper-order-adapter';
import type { CreateOrderRequest, Order } from './order-domain';

const request: CreateOrderRequest = {
  id: 'order-1',
  clientOrderId: 'client-1',
  symbol: '005930',
  side: 'buy',
  orderType: 'limit',
  quantity: 2,
  limitPrice: 70000,
};

const order: Order = {
  ...request,
  brokerOrderId: '12345',
  brokerOrderOrgNo: '678901',
  executedQuantity: 0,
  averageExecutedPrice: 0,
  status: 'ACCEPTED',
  createdAt: '2026-09-14T09:00:00.000Z',
  updatedAt: '2026-09-14T09:01:00.000Z',
};

function client(response: unknown) {
  return {
    postJsonResponse: vi.fn().mockResolvedValue({ data: response, headers: new Headers() }),
  } as never;
}

describe('KISPaperOrderAdapter', () => {
  it('uses PAPER buy TR and current order contract', async () => {
    const fakeClient = client({ rt_cd: '0', msg_cd: 'APBK0013', msg1: 'ok', output: { ODNO: '12345', KRX_FWDG_ORD_ORGNO: '678901', ORD_TMD: '101500' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '12345678', '01');

    const result = await adapter.submit(request);

    expect(result).toMatchObject({ accepted: true, brokerOrderId: '12345', brokerOrderOrgNo: '678901', orderTime: '101500' });
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
    const fakeClient = client({ rt_cd: '0', output: { ODNO: '67890', KRX_FWDG_ORD_ORGNO: '678901' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '12345678', '01');

    await adapter.submit({ ...request, side: 'sell', orderType: 'market', limitPrice: undefined });

    expect((fakeClient as any).postJsonResponse).toHaveBeenCalledWith(
      '/uapi/domestic-stock/v1/trading/order-cash',
      expect.objectContaining({ ORD_DVSN: '01', ORD_QTY: '2', ORD_UNPR: '0', SLL_TYPE: '01' }),
      { tr_id: 'VTTC0011U', custtype: 'P' },
    );
  });

  it('cancels an accepted PAPER order with the official cancel contract', async () => {
    const fakeClient = client({ rt_cd: '0', msg_cd: 'APBK0014', msg1: 'cancelled', output: { ODNO: '99999', ORD_TMD: '102000' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '12345678', '01');

    const result = await adapter.cancel(order);

    expect(result).toMatchObject({ accepted: true, brokerOrderId: '99999', orderTime: '102000' });
    expect((fakeClient as any).postJsonResponse).toHaveBeenCalledWith(
      '/uapi/domestic-stock/v1/trading/order-rvsecncl',
      {
        CANO: '12345678',
        ACNT_PRDT_CD: '01',
        KRX_FWDG_ORD_ORGNO: '678901',
        ORGN_ODNO: '12345',
        ORD_DVSN: '00',
        RVSE_CNCL_DVSN_CD: '02',
        ORD_QTY: '0',
        ORD_UNPR: '0',
        QTY_ALL_ORD_YN: 'Y',
        EXCG_ID_DVSN_CD: 'KRX',
        CNDT_PRIC: '',
      },
      { tr_id: 'VTTC0013U', custtype: 'P' },
    );
  });

  it('returns a cancel business rejection without changing the order', async () => {
    const fakeClient = client({ rt_cd: '1', msg_cd: 'EGW00201', msg1: 'rejected' });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '12345678', '01');

    await expect(adapter.cancel(order)).resolves.toEqual({ accepted: false, messageCode: 'EGW00201', message: 'rejected' });
  });

  it('rejects cancellation when broker organization id is missing', async () => {
    const fakeClient = client({ rt_cd: '0', output: { ODNO: '99999' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '12345678', '01');

    await expect(adapter.cancel({ ...order, brokerOrderOrgNo: undefined })).rejects.toThrow('PAPER_ORDER_BROKER_ORGNO_REQUIRED');
    expect((fakeClient as any).postJsonResponse).not.toHaveBeenCalled();
  });

  it('never submits through the adapter in LIVE environment', async () => {
    const fakeClient = client({ rt_cd: '0', output: { ODNO: '12345', KRX_FWDG_ORD_ORGNO: '678901' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'LIVE', '12345678', '01');

    await expect(adapter.submit(request)).rejects.toThrow('PAPER_ORDER_REQUIRES_PAPER_ENVIRONMENT');
    await expect(adapter.cancel(order)).rejects.toThrow('PAPER_ORDER_REQUIRES_PAPER_ENVIRONMENT');
    expect((fakeClient as any).postJsonResponse).not.toHaveBeenCalled();
  });

  it('rejects invalid account configuration', async () => {
    const fakeClient = client({ rt_cd: '0', output: { ODNO: '12345', KRX_FWDG_ORD_ORGNO: '678901' } });
    const adapter = new KISPaperOrderAdapter(fakeClient, 'PAPER', '1234', '01');

    await expect(adapter.submit(request)).rejects.toThrow('KIS account CANO must use 8 digits');
  });
});
