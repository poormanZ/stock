import { KISCashOrderAdapter } from './kis-cash-order-adapter';
import type { KISEnvironment } from './kis-common';
import type { KISHttpClient } from './kis-http-client';

/**
 * 실전투자(LIVE) 현금주문 어댑터. 이 클래스는 live-routes의 실계좌 게이트를 통과한 경우에만 생성된다.
 * 클라이언트 환경이 LIVE가 아니면 어떤 요청도 보내지 않는다.
 */
export class KISLiveOrderAdapter extends KISCashOrderAdapter {
  constructor(client: KISHttpClient, environment: KISEnvironment, cano: string, accountProductCode: string) {
    super(client, environment, cano, accountProductCode, 'LIVE');
  }
}
