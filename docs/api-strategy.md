# 실제 주식 데이터 API 선정 기록

작성일: 2026-09-04

## 1. 1차 공급자 선정
**한국투자증권 Open API(KIS Open API)**를 국내 주식 시세의 1차 실제 데이터 공급자로 선정한다.

공식 문서에서 국내주식 기본 시세의 `주식현재가 시세` 및 기간별 시세, 분봉 등 REST API를 제공하며, 종목정보 마스터 파일도 제공한다. 향후 실시간 체결 데이터가 필요하면 WebSocket으로 확장할 수 있다.

## 2. 핵심 제약
KIS REST API는 Appkey/Appsecret 기반 인증과 Access Token 발급을 사용한다. 따라서 Appsecret을 GitHub Pages의 브라우저 코드에 포함하지 않는다.

현재 배포 구조가 정적 GitHub Pages이므로 실제 연동은 다음 구조를 사용한다.

```text
Browser / GitHub Pages
        ↓
QuoteProvider
        ↓
Backend / Serverless Proxy
        ↓
KIS Open API
```

백엔드에서 KIS 인증정보를 Secret으로 보관하고, 브라우저에는 필요한 시세 데이터만 전달한다.

## 3. 구현 순서
1. KIS 이용 신청 및 Appkey/Appsecret 발급
2. 서버리스/백엔드 실행 환경 결정
3. KIS Access Token 발급 모듈 구현
4. 국내주식 현재가 API Adapter 구현
5. KIS 응답을 `StockQuote`로 변환
6. Provider 오류/지연/토큰 만료 처리
7. 프론트엔드에서 실제 Provider 선택
8. GitHub Pages + 백엔드 통합 검증

## 4. 보안 원칙
- Appkey/Appsecret을 소스 코드에 커밋하지 않는다.
- `.env` 및 Secret 파일을 Git에 포함하지 않는다.
- 브라우저 번들에 Appsecret을 포함하지 않는다.
- API 오류 응답에 인증정보가 노출되지 않도록 한다.
- 서버 측에서 호출 제한과 재시도 정책을 적용한다.

## 5. 참고
KIS Developers 공식 문서: https://apiportal.koreainvestment.com/

NAVER Developers 검색 API는 주식 시세 전용 공급자가 아니므로 채택하지 않는다.
