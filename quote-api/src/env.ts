import { KISAccountAdapter } from './kis-account-adapter';
import { type KISEnvironment, parseEnvironment } from './kis-common';
import { KISHttpClient } from './kis-http-client';
import { KISOrderAdapter } from './kis-order-adapter';
import { KISPaperOrderAdapter } from './kis-paper-order-adapter';
import { KISQuoteAdapter } from './kis-quote-adapter';

export interface Env {
  APP_KEY: string;
  APP_SECRET: string;
  ACCOUNT_CANO: string;
  ACCOUNT_PRODUCT_CODE: string;
  KIS_TOKEN_CACHE: KVNamespace;
  KIS_TOKEN_BROKER: DurableObjectNamespace;
  INTERNAL_STATE_STORE: DurableObjectNamespace;
  DRY_RUN_STATE_STORE: DurableObjectNamespace;
  RISK_STATE_STORE: DurableObjectNamespace;
  KIS_ENVIRONMENT?: string;
  KIS_BASE_URL?: string;
  ALLOWED_ORIGIN?: string;
}

export type StateStoreBinding = 'INTERNAL_STATE_STORE' | 'DRY_RUN_STATE_STORE' | 'RISK_STATE_STORE';

export function getEnvironment(env: Env): KISEnvironment {
  return parseEnvironment(env.KIS_ENVIRONMENT);
}

export function isAccountConfigured(env: Env): boolean {
  return Boolean(env.ACCOUNT_CANO && env.ACCOUNT_PRODUCT_CODE);
}

export function createClient(env: Env): KISHttpClient {
  return new KISHttpClient({
    appKey: env.APP_KEY,
    appSecret: env.APP_SECRET,
    environment: getEnvironment(env),
    baseUrl: env.KIS_BASE_URL,
    tokenCache: env.KIS_TOKEN_CACHE,
    tokenBroker: env.KIS_TOKEN_BROKER,
  });
}

export function createQuoteAdapter(env: Env): KISQuoteAdapter {
  return new KISQuoteAdapter(createClient(env));
}

export function createAccountAdapter(env: Env): KISAccountAdapter {
  return new KISAccountAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE);
}

export function createOrderAdapter(env: Env): KISOrderAdapter {
  return new KISOrderAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE);
}

export function createPaperOrderAdapter(env: Env): KISPaperOrderAdapter {
  return new KISPaperOrderAdapter(createClient(env), getEnvironment(env), env.ACCOUNT_CANO, env.ACCOUNT_PRODUCT_CODE);
}

/** 상태 저장 DO는 단일 인스턴스('primary')로 운영한다 */
export function getPrimaryStore(env: Env, binding: StateStoreBinding): DurableObjectStub {
  return env[binding].get(env[binding].idFromName('primary'));
}
