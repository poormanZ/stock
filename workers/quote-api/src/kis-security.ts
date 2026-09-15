const SENSITIVE_KEY_PATTERN = /(app[_-]?key|app[_-]?secret|appsecret|access[_-]?token|authorization|bearer)/i;
// "authorization: Bearer <token>"처럼 스킴이 붙은 값은 토큰까지 함께 지운다
const SENSITIVE_TEXT_PATTERN = /(appkey|app_key|app-secret|appsecret|access[_-]?token|authorization|bearer)(\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi;

export function redactSensitiveHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : value]),
  );
}

export function redactSensitiveText(text: string): string {
  return text.replace(SENSITIVE_TEXT_PATTERN, '$1$2[REDACTED]');
}
