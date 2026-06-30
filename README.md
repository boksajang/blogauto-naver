# Blogauto Naver + Tistory

Codex 기반 Windows 데스크톱 자동화 콘솔입니다. Naver Blog 글 생성/발행을 기본 흐름으로 사용하고, Naver 발행이 성공하면 같은 제목, 본문, 이미지, 카테고리, 태그를 Tistory 블로그에도 이어서 발행할 수 있습니다.

## 주요 기능

- Naver 계정 여러 개와 계정별 카테고리 관리
- 카테고리별 키워드, 발행 목적, 검색 채널, 블로그 신뢰 설정 관리
- Research/Title Agent, Writer Agent, Main Review Agent, Image Worker 기반 글 생성
- 현재성/공식성/신뢰매체 근거 검증
- Naver 세션 확인, 수동 보안 확인 후 세션 재사용
- Tistory Kakao 로그인 세션 확인 및 재사용
- Naver 발행 성공 후 Tistory 동일 글 자동 발행
- Tistory-only 테스트 발행
- 공개, 비공개, 예약 발행 설정
- 제목 이미지와 본문 이미지 생성 및 업로드
- 태그 입력, 카테고리 매칭, 인용구 스타일 변환

## 기본 흐름

1. 계정, 카테고리, 키워드, 발행 목적을 설정합니다.
2. 필요하면 세션 일괄 확인으로 Naver와 Tistory 로그인 상태를 확인합니다.
3. Research/Title Agent가 주제와 제목 후보를 고르고 검색 근거를 수집합니다.
4. Writer Agent가 본문과 태그, 이미지 프롬프트를 작성합니다.
5. Main Review Agent가 제목 일치, 근거 신뢰도, 본문 품질, 독자 가치, 현재성 기준을 검토합니다.
6. Image Worker가 이미지를 생성합니다.
7. Naver Blog에 글을 작성하고 발행합니다.
8. Tistory 발행 옵션이 켜져 있고 세션이 유효하면 같은 글을 Tistory에도 발행합니다.

## 검색과 근거 기준

정책, 채용, 지원금, 신청, 모집, 법률, 가격, 일정처럼 독자 행동에 직접 영향을 주는 글은 공식 또는 기관 근거를 우선합니다.

AI 업계동향, 기술 발표, 모델 출시, 반도체 시장 변화 같은 글은 Naver Blog 후보만으로 확정하지 않습니다. 공식 출처가 없더라도 독립 편집 매체 또는 신뢰 가능한 웹 근거가 함께 확인되어야 합니다. 블로그 후보는 주제 발견 단서로 사용할 수 있지만, 블로그만으로 발표형 글을 발행하지 않습니다.

## 실행

```bash
npm install
npm start
```

검사:

```bash
npm run check
```

빌드:

```bash
npm run dist
```

저장된 작업 실행:

```bash
npm run run:saved
```

최신 생성 결과 발행:

```bash
npm run publish:latest
```

## Tistory 테스트

앱 화면의 `Tistory 테스트 발행` 버튼을 사용하면 Naver 글 생성과 Naver 발행을 건너뛰고 Tistory 로그인, 본문 입력, 이미지 업로드, 카테고리 선택, 태그 입력, 최종 발행 흐름만 빠르게 테스트할 수 있습니다.

## 로컬 데이터와 계정정보

계정, 비밀번호, 세션, 브라우저 프로필, 작업 로그, 생성 이미지, 빌드 결과는 Git에 올리지 않습니다. 대표 제외 대상은 다음과 같습니다.

- `runtime/`
- `dist/`
- `node_modules/`
- `**/user-settings.json`
- `**/account-categories.json`
- `**/account-assets/`
- `**/browser-profile/`
- `**/browser-profiles/`
- `.env`, `.env.*`, `*.local`
- `.codex/`, `.agents/`

## 주요 파일

- `src/main.js`: Electron main process, 작업 흐름, 세션 확인, Naver/Tistory 발행 오케스트레이션
- `src/lib/codexRunner.js`: Research/Title, Writer, Main Review, Image Worker 실행과 프롬프트 구성
- `src/lib/search.js`: 검색 후보 수집, 공식/기관/독립 신뢰 근거 판정, source quality 요약
- `src/lib/naverPublisher.js`: Naver 로그인, 글쓰기 편집기, 이미지/카테고리/태그/발행 자동화
- `src/lib/tistoryPublisher.js`: Tistory Kakao 세션, TinyMCE 본문 입력, 이미지/카테고리/태그/발행 자동화
- `src/lib/accountStore.js`: 계정과 카테고리 저장 구조
- `src/lib/settings.js`: 앱 설정 기본값과 정규화
- `src/renderer/`: Electron renderer UI
- `scripts/check.js`: 프로젝트 구조와 핵심 회귀 조건 검사
