# Stock Dashboard

여러 주식 종목의 핵심 시세를 한 화면에서 확인하기 위한 웹 대시보드입니다.

## 기술 스택

- Vite
- TypeScript
- HTML/CSS 기반 컴포넌트 구조
- GitHub Actions
- GitHub Pages

## 개발

```bash
npm install
npm run dev
```

빌드 검증:

```bash
npm run build
```

## 배포

`main` 브랜치에 변경사항이 반영되면 GitHub Actions가 빌드 후 GitHub Pages로 배포합니다.

저장소가 프로젝트 Pages(`poormanZ.github.io/stock/`)에서 서비스되도록 Vite base 경로를 `/stock/`으로 설정했습니다.

> GitHub 저장소 Settings → Pages에서 Source를 `GitHub Actions`로 한 번 설정해야 합니다.

## 개발 단계

현재 **Phase 0 — 기반 구축**을 진행 중입니다. 다음 단계에서 샘플 주가 데이터와 실제 대시보드 카드 UI를 구현합니다.
