# STATE — Dusk Parlor Browser

## 목표
RisuAI 호환 **혼합형 iOS/iPadOS 앱**. 화면 뼈대는 네이티브(Swift), 리수 로직(CBS·프롬프트·정규식)은 리수 원본 코드를 JavaScriptCore에서 실행, 메시지 꾸밈만 작은 웹뷰. 기존 플러그인은 지원 안 함. 목적: 웹뷰 OOM 회피. 라이선스 AGPL-3.0.

## 지금까지
- `ios/`: WKWebView 셸(허용 목록, 사이트별 저장소, OOM 복구·초안 복원, 크래시 기록, HUD, iPad). 빌드는 아직 한 번도 안 해 봄.
- `core-poc/`: 리수 CBS를 DOM 없이 실행 → 리수 자체 테스트 68건 중 67건 일치 (나머지 1건은 리수 원본 버그).
- `core-poc/prompt/`: 리수 원본 `sendChat`을 실행해 전송 직전 프롬프트를 가로챔 → 로어북·정규식·CBS·예시 대화·작가 노트까지 조립 확인. 샌드박스와 일반 Node 결과 동일.
- 시험 실행 환경: 리수 소스를 `/home/claude/risu-src`(kwaroran/RisuAI), CCardLib을 `/home/claude/ccardlib`에 클론해서 Bun으로 묶음. npm 저장소 접속 불가.

- `core-poc/compare/`: 실제 리수 요청 로그와 대조. 캐릭터에서 나온 메시지 17개가 글자 하나까지 일치했고, 남은 차이는 Lua(미구현), 외부 모듈, 첫 메시지를 로어북 검색에 넣는지 여부로 설명돼요. 프리셋은 사용자 개인정보가 있어 대조하지 않았어요.

## 다음 할 일 (순서대로)
1. 맥에서 `ios/` 첫 빌드 → 컴파일 오류 수정
2. JSContext 안에서 코어 번들 실행 (Swift 쪽 `__risu` 주입, AbortController 폴리필)
3. 네이티브 토크나이저, Lua 엔진 연결
4. 네이티브 채팅 화면 + 메시지용 작은 웹뷰

## 미확인
- 실제 iOS 기기·JavaScriptCore에서의 실행
- 프리셋(프롬프트 템플릿) 배치의 대조
- 응답 수신 후 후처리 단계 (가짜 응답 형식이라 오류)
