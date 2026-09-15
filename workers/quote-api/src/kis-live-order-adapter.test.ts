import { describe, expect, it, vi } from 'vitest';
import { KISLiveOrderAdapter } from './kis-live-order-adapter';
import type { CreateOrderRequest } from './order-domain';

const request: CreateOrderRequest = { id: 'o', clientOrderId: 'c', symbol: '005930', side: 'buy', orderType: 'limit', quantity: 1, limitPrice: 70000 };

function client(response: unknown) {
  return { postJsonResponse: vi.fn().mockResolvedValue({ data: response, headers: new Headers() }) } as never;
}

describe('KISLiveOrderAdapter', () => {
  it('never sends when the client environment is not LIVE', async () => {
    const fake = client({ rt_cd: '0', output: { ODNO: '1', KRX_FWDG_ORD_ORGNO: '2' } });
    await expect(new KISLiveOrderAdapter(fake, 'PAPER', '12345678', '01').submit(request)).rejects.toThrow('LIVE_ORDER_REQUIRES_LIVE_ENVIRONMENT');
    expect((fake as any).postJsonResponse).not.toHaveBeenCalled();
  });

  it('uses real-account TR ids and rejects DRY_RUN identifiers', async () => {
    const fake = client({ rt_cd: '0', output: { ODNO: '1', KRX_FWDG_ORD_ORGNO: '2' } });
    const adapter = new KISLiveOrderAdapter(fake, 'LIVE', '12345678', '01');
    await adapter.submit(request);
    await adapter.submit({ ...request, side: 'sell', orderType: 'market', limitPrice: undefined });
    const trIds = (fake as any).postJsonResponse.mock.calls.map((call: unknown[]) => (call[2] as { tr_id: string }).tr_id);
    expect(trIds).toEqual(['TTTC0012U', 'TTTC0011U']);
    await expect(adapter.submit({ ...request, clientOrderId: 'DRY-1' })).rejects.toThrow('DRY_RUN_ORDER_NOT_ALLOWED_ON_LIVE');
  });
});
