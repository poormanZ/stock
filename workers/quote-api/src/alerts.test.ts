import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendAlert } from './alerts';

describe('sendAlert', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing without a webhook url', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendAlert({}, { level: 'ERROR', title: 't', message: 'm' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a redacted payload and swallows transport errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('ok')).mockRejectedValueOnce(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);
    const env = { ALERT_WEBHOOK_URL: 'https://hook.test/x' };
    expect(await sendAlert(env, { level: 'CRITICAL', title: 'EMERGENCY_STOP', message: 'appsecret=SECRET account 12345678' })).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { text: string; message: string };
    expect(body.message).toBe('appsecret=[REDACTED] account 1234****');
    expect(body.text).toContain('[CRITICAL] EMERGENCY_STOP');
    expect(await sendAlert(env, { level: 'ERROR', title: 't', message: 'm' })).toBe(false);
  });
});
