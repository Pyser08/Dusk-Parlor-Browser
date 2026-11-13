# STATE — Dusk Parlor Browser

## 목표
RisuAI 호환 **혼합형 iOS/iPadOS 앱**. 화면 뼈대는 네이티브(Swift), 리수 로직(CBS·프롬프트·정규식)은 리수 원본 코드를 JavaScriptCore에서 실행, 메시지 꾸밈만 작은 웹뷰. 기존 플러그인은 지원 안 함. 목적: 웹뷰 OOM 회피. 라이선스 AGPL-3.0.

## 지금까지
- `ios/`: WKWebView 셸(허용 목록, 사이트별 저장소, OOM 복구·초안 복원, 크래시 기록, HUD, iPad). 빌드는 아직 한 번도 안 해 봄.
- `core-poc/`: 리수 CBS를 DOM 없이 실행 → 리수 자체 테스트 68건 중 67건 일치 (나머지 1건은 리수 원본 버그).
- `core-poc/prompt/`: 리수 원본 `sendChat`을 실행해 전송 직전 프롬프트를 가로챔 → 로어북·정규식·CBS·예시 대화·작가 노트까지 조립 확인. 샌드박스와 일반 Node 결과 동일.
- 시험 실행 환경: 리수 소스를 `/home/claude/risu-src`(kwaroran/RisuAI), CCardLib을 `/home/claude/ccardlib`에 클론해서 Bun으로 묶음. npm 저장소 접속 불가.

- `core-poc/compare/`: 실제 리수 요청 로그와 대조. 캐릭터에서 나온 메시지 17개가 글자 하나까지 일치했고, 남은 차이는 Lua(미구현), 외부 모듈, 첫 메시지를 로어북 검색에 넣는지 여부로 설명돼요. 프리셋은 사용자 개인정보가 있어 대조하지 않았어요.

## mirror 브랜치 (2026-11-13, 새 방향 시험)
- 서버 헤드리스 Chrome이 리수를 실행하고 폰엔 DOM 변화만 보내는 미러 방식. `server/` (설명은 server/README.md).
- 가짜 리수 페이지 기준 종단 시험 14건 통과(`cd server && CHROME_BIN=... npm test`).
- **실제 PocketRisu(리스바드, localhost:6001)에 붙여 봄.** 로그인, 메인, 사이드바, 캐릭터 관리, 설정, 채팅 열기, 한글 입력+Enter 전송이 맥 브라우저에서 동작함.
  - 고친 것: iframe 스냅샷이 화면을 덮어쓰던 문제(로그인 후 빈 화면), `/api/asset` 401(프록시가 HttpOnly 세션 쿠키를 안 붙임).
  - 플러그인 창(샌드박스 iframe = 별도 프로세스) 미러링 구현 → Dusk Atelier 실제 창 표시·메뉴 이동·닫기 확인. 설계: server/DESIGN-frames.md.
  - alert/confirm/prompt를 폰에 띄우고 답을 서버로 돌려줌.
- 알게 된 것:
  - 플러그인 켜짐 상태는 브라우저마다 저장됨 → 서버 Chrome 플러그인은 미러 화면에서 따로 켜고 꺼야 함.
  - 헤드리스 Chrome에서 OOPIF에 실제 키 이벤트를 보내면 이후 마우스가 iframe에 안 닿음 → iframe 안 키는 합성 KeyboardEvent(isTrusted=false).
  - 응답이 비던 건 미러 문제 아님: OpenRouter deepseek 추론 모델이 출력 토큰을 추론에 다 씀(finish_reason=length).
  - 플러그인 켠 상태에서 서버 페이지 새로고침이 멈춘 적 있음. 프레임 처리 구현 후에는 재현 안 됨(원인 미확정).
- 실제 iPad(크롬)·iPad 시뮬레이터(Safari, Xcode 27)에서 확인: 플러그인 창 조작, 한글 입력, 정규식 추가→채팅 반영, 선택 상자, 파일 가져오기·내보내기, 복사, 프리셋 드래그 정렬.
  - 고친 것(시험 먼저): WebKit에서 플러그인 클릭이 아래 화면으로 감, 아이콘(SVG) 버튼 안 눌림, 누른 자리 대신 가운데를 누름(배경 닫기 안 됨).
  - 시뮬레이터 탭은 1~2초 늦게 반영되고 첫 탭이 무시될 때가 있음 → 탭 뒤 기다렸다 확인할 것.
- 미러 코드에는 리수 전용 코드가 없음(웹 표준 수준에서 처리). 리수 UI가 바뀌거나 포크여도 같은 웹 기술을 쓰는 한 동작.
- RisuBard(github.com/rpaddict/RisuBard, ~/dev/RisuBard, 7777)에도 붙여 봄. 소스 조사로 PocketRisu에 없던 기술(서식 편집기, 우클릭 메뉴, 소리·TTS, 새 창, 알림, 캔버스)을 찾아 모두 구현 + 호버·클립보드 읽기. 시험 31건.
  - RisuBard 실기: 첫 화면·설정·탭 전환 정상, 길게 누르기가 서버 우클릭으로 전달됨(캐릭터 아바타엔 원래 메뉴 없음, 폴더만 있음).
  - 미확인(실기): 서식 편집기(CBS 강조 켠 상태), 소리·TTS, 새 창, 캔버스(3D 보기).
  - RisuBard 시험용 비밀번호: ~/dev/RisuBard/.parlor-test-password. 미러는 별도 프로필(server/.parlor-profile-risubard)로 붙임.
- RisuBard 실기 추가 확인(2026-11-13): 새 창 링크 ✅, TTS 전달 ✅, 오류 창 ✅. 서식 편집기는 RisuBard에서 켜는 경로가 없어 미사용. 안내 상자가 입력줄을 가려 위쪽으로 옮김.
  - 안 함(결정): Web Audio 소리(RisuBard 클릭·호버 효과음). 탭 소리 실시간 전송이 필요해 제외.
  - 남은 실기: 캔버스(3D 보기·이미지 놀이터, 그림/모델 필요). RisuBard에 시험 캐릭터 "미러시험"이 남아 있음(Character Vault에서 삭제).
- 캔버스 실기 ✅(2026-11-13): RisuBard에 Dusk Atelier(v2.1.8)를 미러의 파일 가져오기로 설치 → 장기기억·관계도 애드온 받기 → 가짜 인물 6명 데이터로 관계도 확인. 회전 애니메이션 갱신, 정면 보기, 캔버스 안 노드 클릭(선택·툴팁·옆 패널) 모두 정상. 플러그인 창 안 스크롤도 정상.
  - 남은 것: RisuBard "?"(Unnamed) 캐릭터 채팅에 가짜 관계도 데이터(pluginStorage `dusk.mem.v3.f.70a00cc0772e6ce2`)가 있음. 서버 Chrome(.parlor-profile-risubard)에 Dusk Atelier가 켜져 있음.
- 접속자 처리 결정·구현(2026-11-13): 접속자별 탭 분리는 안 함(리수 DB 통째 저장이라 덮어쓰기 위험). 탭 하나를 한 폰만 쓰고, 새로 연 폰이 이전 폰을 끊음(sid, `bye` 이벤트, 이전 폰 POST 409, "여기서 다시 열기"). 시험 33건, 실제 RisuBard에서도 확인.
- 주소·로그인(2026-11-13): 토큰 제거. `/__parlor/`만 미러, 나머지는 리수로 그대로 넘김(웹소켓 포함) → 리수를 안쪽 포트로 옮기고 미러를 7777에 두면 주소 하나로 PC·폰. 미러는 처음 한 번 리수 비밀번호를 리수 `/api/login`으로 확인. nginx 뒤 SSE 버퍼링 끔(X-Accel-Buffering). 시험 36건.
  - 사용자는 duckdns + nginx로 밖에서 접속 예정. 실기: RisuBard 대상 로그인 화면·틀린 비번 거절·리수 바로 넘기기 확인. `.parlor-test-password`는 지금 RisuBard 비번과 달라 맞는 비번 로그인은 미확인.
- 설치 자동화(2026-11-13): Dusk Cellar처럼 리스 폴더에 install.sh/.command/.bat을 넣으면 `리스/Dusk-Parlor/`에 설치(`parlor-setup.cjs`). Chrome은 설치된 것 → 없으면 Chrome for Testing 헤드리스 판 받기(`chrome-get.cjs`). pm2가 있으면 리스(Cellar) 항목은 포트만 7778로, 미러는 별도 pm2 `dusk-parlor`(사용자 요청). pm2가 없으면 start_parlor 실행 파일 + 함께 켜는 실행기(`parlor-start.cjs`).
  - 확인: 맥(가짜 리스+가짜 Cellar, pm2 없이, 시스템 Chrome), Debian ARM 컨테이너(pm2, apt chromium: 설치·재설치·pm2 resurrect). 미확인: 윈도우 전체, Chrome for Testing 받은 판으로 실행(이 맥에서 받은 실행 파일 실행이 권한 검사에 막힘), 실제 RisuBard, GitHub에서 받는 설치(푸시 전).
  - 푸시: mirror 브랜치, 태그 mirror-v0.1.0. 이 맥의 git 토큰엔 workflow 권한이 없어 릴리즈 워크플로는 못 올림(릴리즈는 웹에서 수동).
- 다음(다음 대화): iOS 셸(`ios/`)이 미러 주소를 열도록 연결(Xcode·iPad 시뮬레이터 준비됨).
- 미확인: 플러그인 창 안 입력·confirm(가짜 시험만), 응답 스트리밍 표시.

## 다음 할 일 (순서대로)
1. 맥에서 `ios/` 첫 빌드 → 컴파일 오류 수정
2. JSContext 안에서 코어 번들 실행 (Swift 쪽 `__risu` 주입, AbortController 폴리필)
3. 네이티브 토크나이저, Lua 엔진 연결
4. 네이티브 채팅 화면 + 메시지용 작은 웹뷰

## 미확인
- 실제 iOS 기기·JavaScriptCore에서의 실행
- 프리셋(프롬프트 템플릿) 배치의 대조
- 응답 수신 후 후처리 단계 (가짜 응답 형식이라 오류)
