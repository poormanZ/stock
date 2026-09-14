import { describe, expect, it } from 'vitest';
import { redactSensitiveHeaders, redactSensitiveText } from './kis-security';

describe('KIS credential redaction', () => {
  it('redacts sensitive headers regardless of key casing', () => {
    const result = redactSensitiveHeaders({
      APP_KEY: 'app-key-secret',
      appsecret: 'app-secret-value',
      Authorization: 'Bearer access-token-value',
      symbol: '005930',
    });

    expect(result.APP_KEY).toBe('[REDACTED]');
    expect(result.appsecret).toBe('[REDACTED]');
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result.symbol).toBe('005930');
  });

  it('redacts credentials embedded in error text', () => {
    const input = 'appkey=APPKEY123 appsecret:SECRET456 authorization=Bearer TOKEN789 symbol=005930';
    const result = redactSensitiveText(input);

    expect(result).not.toContain('APPKEY123');
    expect(result).not.toContain('SECRET456');
    expect(result).not.toContain('Bearer TOKEN789');
    expect(result).toContain('symbol=005930');
  });
});
