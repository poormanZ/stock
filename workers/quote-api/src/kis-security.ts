const SENSITIVE_KEY_PATTERN = /(app[_-]?key|app[_-]?secret|appsecret|access[_-]?token|authorization|bearer)/i;
const SENSITIVE_TEXT_PATTERN = /(appkey|app_key|app-secret|appsecret|access[_-]?token|authorization|bearer)(\s*[:=]\s*)[^\s,;]+/gi;

export function redactSensitiveHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : value]),
  );
}

export function redactSensitiveText(text: string): string {
  return text.replace(SENSITIVE_TEXT_PATTERN, '$1$2[REDACTED]');
}
