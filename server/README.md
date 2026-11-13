# Dusk Parlor Mirror (시제품)

서버의 헤드리스 Chrome이 리수를 실행하고, 폰에는 **화면(DOM) 변화만** 보내는 미러 서버예요.
폰은 리수 스크립트를 실행하지 않고 받은 화면을 그리기만 하므로, 채팅 기록·JS 메모리는 서버에 남아요.

```
리수 서버 ← 헤드리스 Chrome(리수 실행) ─ agent.js ─▶ 미러 서버 ─SSE─▶ 폰(mirror.js)
                         ▲  CDP 클릭·키 입력                     ◀─POST─ 터치·입력·스크롤
```

## 실행
```
cd server
PARLOR_TARGET=http://127.0.0.1:6001 PARLOR_TOKEN=비밀값 npm start
# 폰에서 http://<서버>:7300/__parlor/?token=비밀값 (한 번 열면 쿠키로 기억)
```
| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| PARLOR_TARGET | (필수) | 서버에서 열 리수 주소 |
| PARLOR_PORT / PARLOR_HOST | 7300 / 0.0.0.0 | 미러 서버 주소 |
| PARLOR_TOKEN | 없음 | 설정 시 토큰 없이는 접근 불가 (외부 공개 시 필수) |
| PARLOR_PROFILE | server/.parlor-profile | Chrome 프로필(리수 로그인·저장소 유지) |
| CHROME_BIN | google-chrome | Chrome 실행 파일 |
| PARLOR_DEBUG | 없음 | 설정 시 프레임 연결·클릭·대화상자 진단 로그 출력 |

의존 패키지 없음(Node 22 이상 + Chrome).

## 동작 방식
- 서버→폰: 첫 화면 전체(`snap`) 후 `kids`(자식 목록 변경)·`attr`·`text`·`val`(입력값)·`scroll`만 전송. `<script>`·`on*` 속성은 보내지 않음.
- 폰→서버: 클릭은 폰에서 누른 자리(요소 안 비율)를 서버에서 CDP 실제 마우스로 누름. 아이콘 안 SVG 조각을 누르면 아이콘 전체 기준, 플러그인 창에 가려진 요소는 누르지 않음. 입력값은 조합(한글) 끝난 뒤 전송, Enter·Esc·Tab·방향키는 키 이벤트로 전달. 순서 보장을 위해 양쪽 모두 한 줄로 처리.
- 플러그인 창 같은 iframe(샌드박스·별도 프로세스 포함)은 프레임마다 따로 미러해요. 폰에서는 같은 출처 빈 iframe에 그려요(스크립트는 서버가 애초에 보내지 않음. WebKit 입력 문제로 sandbox는 쓰지 않음). 설계는 [DESIGN-frames.md](DESIGN-frames.md)를 보세요.
- `alert`/`confirm`/`prompt`는 폰에 띄우고, 폰의 답을 서버로 돌려줘요. 폰이 연결돼 있지 않으면 바로 닫아요.
- 정적 파일 프록시는 서버 Chrome의 쿠키를 붙여 보내요(리스바드 세션 쿠키로 보호된 `/api/asset` 등).
- 서버에서만 일어나는 일은 폰 아래 안내 화면으로 이어 받아요.
  - 파일 가져오기: 서버의 파일 창을 가로채(`Page.setInterceptFileChooserDialog`) 폰에 "파일을 골라 주세요" → 고른 파일을 서버 입력칸에 넣음.
  - 내보내기: 서버 Chrome 다운로드를 가로채 폰에 "파일 받기" 링크.
  - 복사: 클립보드 API·`execCommand('copy')`를 가로채 폰 클립보드로(막히면 "폰에 복사" 버튼).
  - 클립보드 읽기: 앱의 `clipboard.readText()`·`read()`는 폰에 "붙여넣을 내용"을 띄워 폰 클립보드나 직접 입력한 글을 돌려줌.
  - 새 창: 서버에 열린 새 탭(`window.open`, `target=_blank`)은 닫고 폰에 "열기" 링크.
  - 알림(`Notification`)은 폰 안내 화면에.
  - Chrome 전용 파일 API(`showSaveFilePicker` 등)는 막아서 위 경로를 쓰게 함.
  - 안내 상자는 최근 3개, 화면 35%까지만. 알림·복사는 8초, 파일 받기·새 창은 1분 뒤 닫힘.
- 소리: 서버 Chrome은 소리가 꺼져 있어서, 오디오 재생·정지와 TTS를 폰에 알려 폰의 Web Audio·`speechSynthesis`로 재생. iOS는 첫 터치 전엔 소리를 못 내므로 그 전에 온 소리는 "소리 켜기" 버튼.
- 캔버스: 그림이 바뀌면 이미지로 보내 폰 캔버스에 그림(WebGL은 `preserveDrawingBuffer` 켬). 다른 출처 그림으로 오염된 캔버스는 못 보냄.
- 서식 편집기(contenteditable): 폰에서 친 글자를 `textContent` + `input` 이벤트로 서버에 넣음. 편집 중엔 그 영역의 서버 갱신을 미뤘다가 끝나면 다시 받음.
- 길게 누르기(550ms)·우클릭은 서버에서 실제 우클릭(contextmenu). 마우스 기기에서는 호버(포인터 이동)도 전달, 터치는 탭할 때 서버 마우스가 그 자리로 옮겨짐.
- 드래그: 마우스는 바로, 터치는 꾹(300ms) 누른 뒤 움직이면 서버에서 실제 마우스 드래그. 네이티브 드래그 앤 드롭은 `Input.setInterceptDrags`로 이어 감.
- `blob:` 이미지는 `/__parlor/blob`으로 서버 페이지에서 꺼내 전달. 그 밖의 정적 파일(CSS·폰트·이미지)은 리수 서버로 프록시.

## 시험
`npm test` — 가짜 리수 페이지를 Chrome 두 개로 확인해요(31건).
- 기본: 첫 화면, 스크립트 차단, CSS 프록시, 쿠키 필요한 파일, blob 이미지, 클릭 왕복, 한글 입력+Enter, 토큰
- 프레임: 같은 출처 iframe, 플러그인 iframe 표시·클릭·입력·`confirm`·재접속 복원·닫기, 가려진 요소 안 누르기
- 터치: 아이콘(SVG) 버튼, 누른 자리 그대로 누르기, click만 오는 입력칸 포커스
- 파일·복사·드래그: 파일 가져오기, 내보내기, 복사, 드래그 앤 드롭
- 그 밖: 서식 편집기, 우클릭·길게 누르기, 새 창, 알림, 소리·TTS, 캔버스, 호버, 클립보드 읽기

맥에서는 `CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test`.

## 알려진 한계
- 플러그인 켜짐 상태는 브라우저마다 따로 저장돼요. 서버 Chrome의 플러그인은 미러 화면에서 켜고 꺼야 해요.
- 헤드리스 Chrome에서 별도 프로세스 iframe에 실제 키 이벤트를 보내면 그 뒤 마우스가 iframe에 닿지 않아요. 그래서 iframe 안의 키는 그 프레임에서 `KeyboardEvent`를 직접 만들어요(`isTrusted`가 false).
- CSSOM으로 넣은 스타일(insertRule, adoptedStyleSheets)·Shadow DOM은 미러되지 않음(PocketRisu·RisuBard 소스에는 없음).
- 접속자별 분리 미구현(지금은 모든 폰이 탭 하나를 공유).
- 터치 전용 처리기(touchstart)는 서버에 마우스로 전달되므로 동작하지 않음. 앱이 마우스 경로도 갖고 있으면 문제없음.
- 서식 편집기는 글자(textContent)만 동기화. 서식 붙여넣기는 글자만 남음.
