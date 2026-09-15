import { redactSensitiveText } from './kis-security';

export type AuditEventType =
  | 'STRATEGY_SIGNAL'
  | 'RISK_APPROVED'
  | 'RISK_BLOCKED'
  | 'ORDER_CREATED'
  | 'ORDER_SUBMITTED'
  | 'ORDER_ACCEPTED'
  | 'ORDER_REJECTED'
  | 'ORDER_PARTIAL_FILL'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELED'
  | 'ORDER_UNKNOWN'
  | 'RECONCILIATION'
  | 'SCHEDULER_RUN'
  | 'LIVE_GATE'
  | 'SYSTEM_ERROR'
  | 'EMERGENCY_STOP';

export type AuditMode = 'DRY_RUN' | 'PAPER' | 'LIVE' | 'SYSTEM';

export interface AuditEventInput {
  type: AuditEventType;
  mode: AuditMode;
  message: string;
  symbol?: string;
  clientOrderId?: string;
  brokerOrderId?: string;
  details?: Record<string, unknown>;
}

export interface AuditEvent extends AuditEventInput {
  id: string;
  at: string;
}

export const AUDIT_LOG_CAPACITY = 500;
const MAX_MESSAGE_LENGTH = 300;
const MAX_DETAILS_LENGTH = 2_000;

/** 8자리 계좌번호는 앞 4자리만 남긴다. 6자리 종목코드는 영향받지 않는다 */
export function maskAccountNumbers(text: string): string {
  return text.replace(/(?<!\d)(\d{4})\d{4}(?!\d)/g, '$1****');
}

function sanitizeText(text: string, limit: number): string {
  return maskAccountNumbers(redactSensitiveText(text)).slice(0, limit);
}

/** 저장 전에 메시지·상세를 마스킹하고 길이를 제한한다. 원본 객체는 변경하지 않는다 */
export function sanitizeAuditEvent(input: AuditEventInput, id: string, at: string): AuditEvent {
  const event: AuditEvent = { id, at, type: input.type, mode: input.mode, message: sanitizeText(input.message, MAX_MESSAGE_LENGTH) };
  if (input.symbol) event.symbol = input.symbol;
  if (input.clientOrderId) event.clientOrderId = input.clientOrderId;
  if (input.brokerOrderId) event.brokerOrderId = input.brokerOrderId;
  if (input.details) {
    const serialized = sanitizeText(JSON.stringify(input.details), MAX_DETAILS_LENGTH);
    try {
      event.details = JSON.parse(serialized) as Record<string, unknown>;
    } catch {
      event.details = { truncated: serialized };
    }
  }
  return event;
}

export function isAuditEventInput(value: unknown): value is AuditEventInput {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuditEventInput>;
  return typeof candidate.type === 'string' && typeof candidate.mode === 'string' && typeof candidate.message === 'string';
}

export class AuditLogStoreDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const events = (await this.state.storage.get<AuditEvent[]>('events')) ?? [];
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), AUDIT_LOG_CAPACITY);
      const type = url.searchParams.get('type');
      const filtered = type ? events.filter((event) => event.type === type) : events;
      return Response.json({ count: filtered.length, events: filtered.slice(-limit).reverse() }, { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });

    const body = await request.json().catch(() => null);
    if (!isAuditEventInput(body)) return Response.json({ error: 'INVALID_AUDIT_EVENT' }, { status: 400 });
    const event = sanitizeAuditEvent(body, crypto.randomUUID(), new Date().toISOString());
    events.push(event);
    await this.state.storage.put('events', events.slice(-AUDIT_LOG_CAPACITY));
    return Response.json(event);
  }
}
