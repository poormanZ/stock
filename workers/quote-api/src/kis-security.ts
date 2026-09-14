const SENSITIVE_KEY_PATTERN = /(app[_-]?key|app[_-]?secret|appsecret|access[_-]?token|authorization|bearer)/i;

export function redactSensitiveValue(value: unknown): string {
  if (typeof value !== 'string') return '[REDACTED]';
  return '[REDACTED]';
}

export function redactSensitiveHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? redactSensitiveValue(value) : value,
    ]),
  );
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/(appkey|app_key|app-secret|appsecret|access[_-]?token|authorization|bearer)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}
