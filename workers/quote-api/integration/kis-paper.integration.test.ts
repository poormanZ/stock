import { describe, expect, it } from 'vitest';
import { KISAccountAdapter } from '../src/kis-account-adapter';
import { KISHttpClient } from '../src/kis-http-client';
import { KISQuoteAdapter } from '../src/kis-quote-adapter';

/**
 * 실제 KIS 모의투자(PAPER) 환경 통합 테스트. 주문은 절대 내지 않는다.
 * 다음 환경변수가 모두 있을 때만 실행된다:
 *   KIS_INTEGRATION_APP_KEY, KIS_INTEGRATION_APP_SECRET, (선택) KIS_INTEGRATION_CANO
 * 실행: npm run test:integration
 */
const appKey = process.env.KIS_INTEGRATION_APP_KEY;
const appSecret = process.env.KIS_INTEGRATION_APP_SECRET;
const cano = process.env.KIS_INTEGRATION_CANO;

describe.skipIf(!appKey || !appSecret)('KIS PAPER integration (read-only)', () => {
  const client = new KISHttpClient({ appKey: appKey!, appSecret: appSecret!, environment: 'PAPER' });

  it('issues an access token and reads a live quote', async () => {
    const quote = await new KISQuoteAdapter(client).getQuote('005930');
    expect(quote.price).toBeGreaterThan(0);
    expect(quote.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 30_000);

  it.skipIf(!cano)('reads the paper account snapshot', async () => {
    const snapshot = await new KISAccountAdapter(client, 'PAPER', cano!, '01').getSnapshot();
    expect(snapshot.environment).toBe('PAPER');
    expect(Number.isFinite(snapshot.cash)).toBe(true);
  }, 30_000);
});
