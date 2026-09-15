import { describe, expect, it } from 'vitest';
import { isTokenUsable, KISTokenIssueError, requestKisToken, toTokenExpiry, TOKEN_SAFETY_MARGIN_MS } from './kis-token';

const now = Date.parse('2026-09-15T00:00:00.000Z');

describe('kis-token', () => {
  it('interprets KIS expiry as KST and applies the safety margin', () => {
    // 2026-09-15 10:00:00 KST == 01:00:00Z
    expect(toTokenExpiry('2026-09-15 10:00:00', now)).toBe(Date.parse('2026-09-15T01:00:00.000Z') - TOKEN_SAFETY_MARGIN_MS);
  });

  it('falls back to a 24h validity when the expiry is missing or malformed', () => {
    const fallback = now + 24 * 60 * 60 * 1000 - TOKEN_SAFETY_MARGIN_MS;
    expect(toTokenExpiry(undefined, now)).toBe(fallback);
    expect(toTokenExpiry('soon', now)).toBe(fallback);
  });

  it('only treats complete, unexpired records as usable', () => {
    expect(isTokenUsable({ accessToken: 't', expiresAt: now + 1 }, now)).toBe(true);
    expect(isTokenUsable({ accessToken: 't', expiresAt: now }, now)).toBe(false);
    expect(isTokenUsable({ expiresAt: now + 1 }, now)).toBe(false);
    expect(isTokenUsable(null, now)).toBe(false);
  });

  it('surfaces KIS token gateway error codes', async () => {
    const fetcher = async () => new Response(JSON.stringify({ error_code: 'EGW00133', error_description: 'retry later' }), { status: 403 });
    await expect(requestKisToken(fetcher, 'https://kis.test', 'k', 's')).rejects.toMatchObject({
      name: 'KISTokenIssueError',
      status: 403,
      code: 'EGW00133',
      message: 'KIS access token request was rejected: retry later',
    } satisfies Partial<KISTokenIssueError>);
  });

  it('returns a record for a successful issuance', async () => {
    const fetcher = async () => new Response(JSON.stringify({ access_token: 'abc', access_token_token_expired: '2099-01-01 00:00:00' }), { status: 200 });
    await expect(requestKisToken(fetcher, 'https://kis.test', 'k', 's')).resolves.toMatchObject({ accessToken: 'abc' });
  });
});
