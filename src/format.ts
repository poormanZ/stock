import type { OrderStatus, TradingStatus } from './api/types';

const wonFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const numberFormat = new Intl.NumberFormat('ko-KR');
const timeFormat = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeFormat = new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const money = (value: number): string => `${wonFormat.format(Math.round(value))}원`;
export const signedMoney = (value: number): string => `${value > 0 ? '+' : ''}${wonFormat.format(Math.round(value))}원`;
export const qty = (value: number): string => numberFormat.format(value);
export const pct = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const time = (value?: string): string => { const d = parseDate(value); return d ? timeFormat.format(d) : '—'; };
export const dateTime = (value?: string): string => { const d = parseDate(value); return d ? dateTimeFormat.format(d) : '—'; };

/** "n초 전" 형태의 상대 시간. 표시용이며 판단에는 쓰지 않는다 */
export function ago(value?: string, now = new Date()): string {
  const date = parseDate(value);
  if (!date) return '—';
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return dateTime(value);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  CREATED: '생성',
  SUBMITTING: '전송 중',
  SUBMITTED: '전송됨',
  ACCEPTED: '접수',
  PARTIALLY_FILLED: '부분체결',
  FILLED: '체결',
  CANCEL_PENDING: '취소 대기',
  CANCELED: '취소',
  REJECTED: '거부',
  UNKNOWN: '미확정',
  RECONCILING: '대조 중',
};

export const TRADING_STATUS_LABEL: Record<TradingStatus, string> = {
  STOPPED: '정지',
  READY: '준비',
  RUNNING: '실행 중',
  ERROR: '오류',
  EMERGENCY_STOP: '긴급정지',
};

const AUDIT_TYPE_LABEL: Record<string, string> = {
  STRATEGY_SIGNAL: '전략 신호',
  RISK_APPROVED: 'Risk 승인',
  RISK_BLOCKED: 'Risk 차단',
  ORDER_CREATED: '주문 생성',
  ORDER_SUBMITTED: '주문 전송',
  ORDER_ACCEPTED: '주문 접수',
  ORDER_REJECTED: '주문 거부',
  ORDER_PARTIAL_FILL: '부분체결',
  ORDER_FILLED: '체결',
  ORDER_CANCELED: '취소',
  ORDER_UNKNOWN: '결과 미확정',
  RECONCILIATION: '대조/동기화',
  SCHEDULER_RUN: '자동매매',
  LIVE_GATE: '실계좌 게이트',
  SYSTEM_ERROR: '시스템 오류',
  EMERGENCY_STOP: '긴급정지',
};

export const orderStatusLabel = (status: string): string => ORDER_STATUS_LABEL[status as OrderStatus] ?? status;
export const tradingStatusLabel = (status: string): string => TRADING_STATUS_LABEL[status as TradingStatus] ?? status;
export const auditTypeLabel = (type: string): string => AUDIT_TYPE_LABEL[type] ?? type;
export const sideLabel = (side: string): string => side === 'buy' ? '매수' : side === 'sell' ? '매도' : side === 'hold' ? '관망' : side;

/** 상태를 색 톤으로 매핑한다: ok(초록) / warn(노랑) / bad(빨강) / neutral */
export function tone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (['FILLED', 'ACCEPTED', 'RUNNING', 'MATCHED', 'OK'].includes(status)) return 'ok';
  if (['PARTIALLY_FILLED', 'SUBMITTING', 'SUBMITTED', 'CANCEL_PENDING', 'RECONCILING', 'READY', 'SKIPPED', 'PENDING'].includes(status)) return 'warn';
  if (['REJECTED', 'UNKNOWN', 'ERROR', 'EMERGENCY_STOP', 'MISMATCHED', 'CANCELED'].includes(status)) return 'bad';
  return 'neutral';
}

/** 전략 신호 사유 코드를 사람이 읽는 문장으로 바꾼다 */
export function describeReason(reason?: string): string {
  if (!reason) return '';
  const stop = /^STOP_LOSS:(.+)%/.exec(reason);
  if (stop) return `손절 (평균단가 대비 ${stop[1]}%)`;
  const take = /^TAKE_PROFIT:(.+)%/.exec(reason);
  if (take) return `익절 (평균단가 대비 +${take[1].replace('+', '')}%)`;
  const trailing = /^TRAILING_STOP:(.+)%/.exec(reason);
  if (trailing) return `트레일링 스탑 (진입 후 최고가 대비 ${trailing[1]}%)`;
  const cross = /^SMA(\d+)([<>])SMA(\d+)(?:\+T(\d+))?(.*)$/.exec(reason);
  if (cross) return `${cross[1]}일선이 ${cross[3]}일선을 ${cross[2] === '>' ? '상향' : '하향'} 돌파${cross[4] ? ` (${cross[4]}일선 위)` : ''}${cross[5].includes('NO_SIZE') ? ' · 주문 가능 수량 없음' : ''}`;
  const momentum = /^MOMENTUM_(UP|DOWN):(.+)%(.*)$/.exec(reason);
  if (momentum) return `${momentum[1] === 'UP' ? '모멘텀 양전환' : '모멘텀 음전환'} (기준 기간 수익률 ${momentum[2]}%)${momentum[3].includes('NO_SIZE') ? ' · 주문 가능 수량 없음' : ''}`;
  const below = /^BELOW_TREND:(\d+)/.exec(reason);
  if (below) return `${below[1]}일선 아래여서 진입 보류`;
  const vb = /^VB_BREAKOUT:k=(.+)$/.exec(reason);
  if (vb) return `변동성 돌파 (k=${vb[1]})`;
  const map: Record<string, string> = {
    NO_SIGNAL: '신호 없음',
    WARMUP: '데이터 준비 중',
    INSUFFICIENT_CANDLES: '일봉 부족',
    INVALID_PRICE: '시세 없음',
    MARKET_CLOSED: '장 마감',
    KILL_SWITCH_ACTIVE: 'Kill Switch 활성',
    ALREADY_PLACED: '오늘 이미 주문함',
    VB_EXIT_NEXT_OPEN: '변동성 돌파 익일 시가 청산',
    manual: '수동 주문',
    dashboard: '대시보드',
  };
  return map[reason] ?? reason;
}
