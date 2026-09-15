import { describe, expect, it } from 'vitest';
import { AUDIT_LOG_CAPACITY, AuditLogStoreDO, maskAccountNumbers, sanitizeAuditEvent } from './audit-log';

function stateStub(): DurableObjectState {
  let value: unknown;
  return { storage: { get: async () => value, put: async (_key: string, next: unknown) => { value = next; } } } as unknown as DurableObjectState;
}

describe('audit log', () => {
  it('masks 8-digit account numbers but keeps 6-digit symbols and order ids', () => {
    expect(maskAccountNumbers('CANO 12345678 symbol 005930 odno 0000012345')).toBe('CANO 1234**** symbol 005930 odno 0000012345');
  });

  it('redacts credentials in message and details', () => {
    const event = sanitizeAuditEvent({ type: 'SYSTEM_ERROR', mode: 'SYSTEM', message: 'appkey=ABC failed for 12345678', details: { header: 'authorization: Bearer TOKEN', symbol: '005930' } }, 'id', 'at');
    expect(event.message).toBe('appkey=[REDACTED] failed for 1234****');
    expect(JSON.stringify(event.details)).not.toContain('TOKEN');
    expect(event.details?.symbol).toBe('005930');
  });

  it('appends, caps and filters events through the Durable Object', async () => {
    const store = new AuditLogStoreDO(stateStub());
    const post = (type: string) => store.fetch(new Request('https://audit-log/', { method: 'POST', body: JSON.stringify({ type, mode: 'DRY_RUN', message: type }) }));
    for (let i = 0; i < AUDIT_LOG_CAPACITY + 5; i += 1) await post(i % 2 ? 'ORDER_FILLED' : 'RISK_BLOCKED');
    const all = await (await store.fetch(new Request('https://audit-log/?limit=1000'))).json() as { count: number; events: { type: string }[] };
    expect(all.count).toBe(AUDIT_LOG_CAPACITY);
    const filtered = await (await store.fetch(new Request('https://audit-log/?type=ORDER_FILLED&limit=3'))).json() as { events: { type: string }[] };
    expect(filtered.events).toHaveLength(3);
    expect(filtered.events.every((event) => event.type === 'ORDER_FILLED')).toBe(true);
    expect((await store.fetch(new Request('https://audit-log/', { method: 'POST', body: '{}' }))).status).toBe(400);
  });
});
