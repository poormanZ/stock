import { describe, expect, it } from 'vitest';
import { InternalStateStore } from './internal-state-store';

function stateStub(initial?: unknown): DurableObjectState {
  let value = initial;
  return { storage: { get: async () => value, put: async (_key: string, next: unknown) => { value = next; } } } as unknown as DurableObjectState;
}

describe('InternalStateStore', () => {
  it('starts empty and persists replacement state', async () => {
    const store = new InternalStateStore(stateStub());
    expect((await store.get()).positions).toEqual([]);
    const saved = await store.replace({ positions: [{ symbol: '005930', quantity: 2 }], orders: [] });
    expect(saved.positions[0]).toEqual({ symbol: '005930', quantity: 2 });
    expect((await store.get()).positions[0].quantity).toBe(2);
  });
});
