import type { Env } from './env';
import { maskAccountNumbers } from './audit-log';
import { redactSensitiveText } from './kis-security';

export type AlertLevel = 'WARN' | 'ERROR' | 'CRITICAL';

export interface Alert {
  level: AlertLevel;
  title: string;
  message: string;
  details?: Record<string, unknown>;
}

const ALERT_TIMEOUT_MS = 5_000;

/**
 * ALERT_WEBHOOK_URL로 JSON을 POST한다. Slack incoming webhook과 호환되도록 `text`도 함께 보낸다.
 * 알림 실패가 주문 처리 자체를 막지 않도록 모든 오류를 흡수하고 콘솔에만 남긴다.
 */
export async function sendAlert(env: Pick<Env, 'ALERT_WEBHOOK_URL'>, alert: Alert): Promise<boolean> {
  const url = env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return false;
  const message = maskAccountNumbers(redactSensitiveText(alert.message)).slice(0, 1_000);
  const payload = {
    level: alert.level,
    title: alert.title,
    message,
    details: alert.details,
    at: new Date().toISOString(),
    text: `[${alert.level}] ${alert.title}: ${message}`,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) console.error('alert webhook rejected', { status: response.status, title: alert.title });
    return response.ok;
  } catch (error) {
    console.error('alert webhook failed', error instanceof Error ? error.message : 'unknown error');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
