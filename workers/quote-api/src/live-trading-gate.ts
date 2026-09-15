import { toKstDate } from './kis-common';
import type { KISEnvironment } from './kis-common';

/** 실계좌 주문 요청 본문과 arm 요청에 모두 포함해야 하는 확인 문구 */
export const LIVE_TRADING_CONFIRMATION = 'I_UNDERSTAND_LIVE_TRADING';
export const LIVE_ARM_MAX_TTL_SECONDS = 15 * 60;

export interface LiveArmState {
  armedUntil: string;
  reason: string;
  armedAt: string;
}

export type LiveGateReason =
  | 'OK'
  | 'LIVE_TRADING_DISABLED'
  | 'PAPER_VERIFICATION_REQUIRED'
  | 'LIVE_ENVIRONMENT_REQUIRED'
  | 'ACCOUNT_NOT_CONFIGURED'
  | 'KILL_SWITCH_ACTIVE'
  | 'MARKET_SESSION_CLOSED'
  | 'LIVE_TRADING_NOT_ARMED'
  | 'LIVE_CONFIRMATION_REQUIRED';

export interface LiveGateInput {
  /** 환경변수 LIVE_TRADING_ENABLED. 정확히 'true'일 때만 활성 */
  liveTradingEnabled: string | undefined;
  /** 환경변수 PAPER_VERIFICATION_DATE(YYYYMMDD). 모의투자 안정성 검증 완료일에 대한 운영자 확인 */
  paperVerificationDate: string | undefined;
  environment: KISEnvironment;
  accountConfigured: boolean;
  killSwitchActive: boolean;
  marketOpen: boolean;
  arm: LiveArmState | null | undefined;
  confirmation: unknown;
  now: Date;
}

export interface LiveGateResult {
  allowed: boolean;
  reason: LiveGateReason;
  /** 진단용: 실패한 첫 조건 외에 함께 확인한 항목 */
  checks: Record<string, boolean>;
}

export function isArmed(arm: LiveArmState | null | undefined, now: Date): boolean {
  return Boolean(arm) && Date.parse(arm!.armedUntil) > now.getTime();
}

function isVerificationDateValid(value: string | undefined, now: Date): boolean {
  if (!value || !/^\d{8}$/.test(value)) return false;
  const today = toKstDate(now);
  return today !== null && value <= today;
}

/**
 * 실계좌 주문 최종 게이트. 순서대로 검사하며 하나라도 실패하면 차단한다.
 * 기본값(환경변수 미설정)은 항상 LIVE_TRADING_DISABLED다.
 */
export function checkLiveTradingGate(input: LiveGateInput): LiveGateResult {
  const checks = {
    enabled: input.liveTradingEnabled === 'true',
    paperVerified: isVerificationDateValid(input.paperVerificationDate, input.now),
    liveEnvironment: input.environment === 'LIVE',
    accountConfigured: input.accountConfigured,
    killSwitchOff: !input.killSwitchActive,
    marketOpen: input.marketOpen,
    armed: isArmed(input.arm, input.now),
    confirmed: input.confirmation === LIVE_TRADING_CONFIRMATION,
  };
  const ordered: [keyof typeof checks, LiveGateReason][] = [
    ['enabled', 'LIVE_TRADING_DISABLED'],
    ['paperVerified', 'PAPER_VERIFICATION_REQUIRED'],
    ['liveEnvironment', 'LIVE_ENVIRONMENT_REQUIRED'],
    ['accountConfigured', 'ACCOUNT_NOT_CONFIGURED'],
    ['killSwitchOff', 'KILL_SWITCH_ACTIVE'],
    ['marketOpen', 'MARKET_SESSION_CLOSED'],
    ['armed', 'LIVE_TRADING_NOT_ARMED'],
    ['confirmed', 'LIVE_CONFIRMATION_REQUIRED'],
  ];
  for (const [key, reason] of ordered) if (!checks[key]) return { allowed: false, reason, checks };
  return { allowed: true, reason: 'OK', checks };
}
