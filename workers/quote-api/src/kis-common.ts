import type { KISJsonResponse } from './kis-http-client';

export type KISEnvironment = 'PAPER' | 'LIVE';

/** KIS 응답 공통 메타 필드 */
export interface KISResponseMeta {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
}

export type KISOperation = 'balance' | 'account asset' | 'buyable' | 'order history';

export const LIVE_BASE_URL = 'https://openapi.koreainvestment.com:9443';
export const PAPER_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
const MAX_PAGES = 20;

export function parseEnvironment(value: string | undefined): KISEnvironment {
  return value === 'LIVE' ? 'LIVE' : 'PAPER';
}

export function resolveBaseUrl(environment: KISEnvironment, override?: string): string {
  if (override) return override.replace(/\/$/, '');
  return environment === 'LIVE' ? LIVE_BASE_URL : PAPER_BASE_URL;
}

/** 계좌 설정(CANO/상품코드) 오류. 호출자는 503 ACCOUNT_CONFIG_INVALID로 매핑한다 */
export class KISAccountConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KISAccountConfigError';
  }
}

/** KIS가 rt_cd != '0'으로 거부한 조회 요청 */
export class KISRejectedError extends Error {
  constructor(
    public readonly operation: KISOperation,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(`KIS ${operation} request failed: ${code}${detail ? ` - ${detail}` : ''}`);
    this.name = 'KISRejectedError';
  }
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function validateAccountParts(cano: string, accountProductCode: string): void {
  if (!/^\d{8}$/.test(cano.trim())) throw new KISAccountConfigError('KIS account CANO must use 8 digits');
  if (accountProductCode.trim() !== '01') throw new KISAccountConfigError('KIS consignment account product code must be 01');
}

/** rt_cd가 정확히 '0'이 아니면 거부로 간주한다 (누락도 거부) */
export function assertAccepted(operation: KISOperation, meta: KISResponseMeta): void {
  if (meta.rt_cd === '0') return;
  throw new KISRejectedError(operation, meta.msg_cd ?? 'UNKNOWN', meta.msg1?.trim() || undefined);
}

export interface KISPaged {
  ctx_area_fk100?: string;
  ctx_area_nk100?: string;
}

export interface KISPageCursor {
  CTX_AREA_FK100: string;
  CTX_AREA_NK100: string;
  tr_cont: '' | 'N';
}

/** tr_cont 연속조회 헤더(F/M = 다음 페이지 있음)를 따라 모든 페이지를 순회한다 */
export async function forEachKisPage<T extends KISPaged & KISResponseMeta>(
  operation: KISOperation,
  fetchPage: (cursor: KISPageCursor) => Promise<KISJsonResponse<T>>,
  onPage: (data: T) => void,
): Promise<void> {
  const cursor: KISPageCursor = { CTX_AREA_FK100: '', CTX_AREA_NK100: '', tr_cont: '' };
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchPage(cursor);
    assertAccepted(operation, response.data);
    onPage(response.data);
    const next = response.headers.get('tr_cont') ?? '';
    if (next !== 'F' && next !== 'M') return;
    cursor.CTX_AREA_FK100 = String(response.data.ctx_area_fk100 ?? '');
    cursor.CTX_AREA_NK100 = String(response.data.ctx_area_nk100 ?? '');
    cursor.tr_cont = 'N';
  }
  throw new Error(`KIS ${operation} pagination limit exceeded`);
}

const KST_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** KST 기준 YYYYMMDD. 유효하지 않은 시각이면 null */
export function toKstDate(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return KST_DATE_FORMAT.format(date).replace(/-/g, '');
}

export function todayKst(): string {
  return toKstDate(new Date()) as string;
}

/** KIS 시세 시각("YYYYMMDD HHMMSS", KST) → ISO 8601. 형식이 다르면 undefined */
export function kisTimestampToIso(value: string | undefined): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})\s+(\d{2})(\d{2})(\d{2})$/.exec((value ?? '').trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
