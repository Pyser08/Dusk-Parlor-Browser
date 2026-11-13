# Dusk Parlor Mirror (시제품)

서버의 헤드리스 Chrome이 리수를 실행하고, 폰에는 **화면(DOM) 변화만** 보내는 미러 서버예요.
폰은 리수 스크립트를 실행하지 않고 받은 화면을 그리기만 하므로, 채팅 기록·JS 메모리는 서버에 남아요.

```
리수 서버 ← 헤드리스 Chrome(리수 실행) ─ agent.js ─▶ 미러 서버 ─SSE─▶ 폰(mirror.js)
                         ▲  CDP 클릭·키 입력                     ◀─POST─ 터치·입력·스크롤
```

## 리스 폴더에 넣어서 설치 (Dusk Cellar와 같은 방식)
| 환경 | 방법 |
|---|---|
| 윈도우 | `install.bat`을 **리스 폴더**(`server\node\server.cjs`가 있는 곳)에 넣고 더블클릭 |
| 맥 | `install.command`를 리스 폴더에 넣고 더블클릭(처음 한 번은 우클릭 → 열기) |
| 리눅스 | 리스 폴더에서 `curl -fsSL https://raw.githubusercontent.com/Pyser08/Dusk-Parlor-Browser/mirror/server/install.sh \| bash` |

- 리스 폴더 안 `Dusk-Parlor/`에 설치돼요. 다시 실행하면 최신으로 바뀌어요(`data/`·`parlor.json`은 그대로).
- Node는 리스의 `bin/node`(휴대용 배포본)를 먼저 쓰고, 없으면 시스템 Node 22 이상을 써요. git은 필요 없어요.
- Chrome: 설치된 Chrome(윈도우는 Edge도)을 쓰고, 없으면 Google의 Chrome for Testing 헤드리스 판을 `Dusk-Parlor/chrome/`에 받아요(관리자 권한 불필요).
- **pm2가 있으면:** 리스(또는 Dusk Cellar 실행기)를 켜던 pm2 항목은 그대로 두고 포트만 7778로 옮긴 뒤, 미러를 따로 pm2 `dusk-parlor`로 7777에 등록해요. 미러는 리스가 응답할 때까지 기다렸다 켜져서 재부팅 때 순서가 섞여도 괜찮아요.
- **pm2가 없으면(휴대용 등):** 리스 폴더에 `start_parlor.command`(맥)·`start_parlor.bat`(윈도우)·`start_parlor.sh`(리눅스)를 만들어요. 이걸로 켜면 리스(Cellar가 있으면 Cellar 실행기)가 7778, 미러가 7777로 함께 켜지고 함께 꺼져요. 미러만 죽으면 미러만 다시 켜요. Chrome이나 Node 22가 없으면 미러 없이 리스를 원래 포트로 켜요.
- 옵션: `--no-pm2`, `--port 7777`, `--risu-port 7778`. 설정은 `Dusk-Parlor/parlor.json`.
- 결과: PC는 `http://<서버>:7777/`(리스 그대로), 폰은 `http://<서버>:7777/__parlor/`.
- Dusk Cellar 실행기는 리스에 `PORT`를 그대로 넘겨서 함께 돌아요.

## 실행
```
cd server
PARLOR_TARGET=http://127.0.0.1:6001 npm start
# 폰에서 http://<서버>:7300/__parlor/ (처음 한 번 리수 비밀번호를 물어봄)
# 그 밖의 주소(http://<서버>:7300/)는 리수로 그대로 넘어감 → PC에서는 리수를 바로 쓰면 됨
```
| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| PARLOR_TARGET | (필수) | 서버에서 열 리수 주소 |
| PARLOR_PORT / PARLOR_HOST | 7300 / 0.0.0.0 | 미러 서버 주소 |
| PARLOR_PROFILE | server/.parlor-profile | Chrome 프로필(리수 로그인·저장소 유지) |
| CHROME_BIN | google-chrome | Chrome 실행 파일 |
| PARLOR_DEBUG | 없음 | 설정 시 프레임 연결·클릭·대화상자 진단 로그 출력 |

의존 패키지 없음(Node 22 이상 + Chrome).

## 동작 방식
- 주소 나누기: `/__parlor/…`만 미러이고, 나머지 요청은 웹소켓까지 리수로 그대로 넘겨요. 그래서 리수를 안쪽 포트(예: 7778)로 옮기고 미러를 원래 포트(7777)에 띄우면 주소 하나로 PC(리수 바로)와 폰(미러) 둘 다 쓸 수 있어요. 단, 양쪽에서 동시에 쓰면 리수 DB 저장이 서로 덮어써질 수 있어요.
- 미러 로그인: 서버 Chrome은 리수에 로그인된 채 남으므로, 미러에 처음 들어오면 리수 비밀번호를 묻고 리수 서버(`/api/login`)에 확인해요. 맞으면 그 기기를 1년 동안 기억해요(`parlor_session` 쿠키, 목록은 Chrome 프로필 폴더의 `parlor-sessions.json`. 지우면 모두 다시 로그인). 리수에 비밀번호가 없으면 묻지 않아요. 틀리면 1초 동안 다시 확인하지 않아요.
- 서버 Chrome의 쿠키(리스바드 세션 등)는 미러에 로그인한 기기의 요청에만 붙여요. 리수를 바로 쓰는 사람은 자기 쿠키로 리수에 로그인해요.
- nginx 같은 앞단 서버 뒤에 둬도 돼요. 화면 스트림에 `X-Accel-Buffering: no`·`no-transform`을 붙여서 nginx 설정을 고치지 않아도 바로바로 전달돼요. 앞단 서버는 사이트 전체(`/`)를 미러로 넘겨 주세요(미러는 `/__parlor/` 말고도 리수 정적 파일 경로를 씀).
- 서버→폰: 첫 화면 전체(`snap`) 후 `kids`(자식 목록 변경)·`attr`·`text`·`val`(입력값)·`scroll`만 전송. `<script>`·`on*` 속성은 보내지 않음.
- 폰→서버: 클릭은 폰에서 누른 자리(요소 안 비율)를 서버에서 CDP 실제 마우스로 누름. 아이콘 안 SVG 조각을 누르면 아이콘 전체 기준, 플러그인 창에 가려진 요소는 누르지 않음. 입력값은 조합(한글) 끝난 뒤 전송, Enter·Esc·Tab·방향키는 키 이벤트로 전달. 순서 보장을 위해 양쪽 모두 한 줄로 처리.
- 플러그인 창 같은 iframe(샌드박스·별도 프로세스 포함)은 프레임마다 따로 미러해요. 폰에서는 같은 출처 빈 iframe에 그려요(스크립트는 서버가 애초에 보내지 않음. WebKit 입력 문제로 sandbox는 쓰지 않음). 설계는 [DESIGN-frames.md](DESIGN-frames.md)를 보세요.
- 서버 탭은 하나이고 한 번에 한 폰만 써요. 다른 폰이 새로 열면 이전 폰은 "다른 기기에서 접속해서 이 화면은 멈췄어요"로 덮이고 입력도 거절돼요(409). 이전 폰은 자동 재연결로 되찾지 않고, "여기서 다시 열기"를 눌러야 되찾아요. 리수가 DB를 통째로 저장하므로 탭을 여러 개 열면 저장이 서로 덮어쓰여서 이렇게 했어요.
- `alert`/`confirm`/`prompt`는 폰에 띄우고, 폰의 답을 서버로 돌려줘요. 폰이 연결돼 있지 않으면 바로 닫아요.
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
- `blob:` 이미지는 `/__parlor/blob`으로 서버 페이지에서 꺼내 전달. 그 밖의 정적 파일(CSS·폰트·이미지)은 위의 넘기기 길로 받아요.

## 시험
`npm test` — 가짜 리수 페이지를 Chrome 두 개로 확인해요(36건).
- 기본: 미러 로그인, 리수로 넘기기(POST·웹소켓), 첫 화면, 스크립트 차단, CSS 프록시, 쿠키 필요한 파일, blob 이미지, 클릭 왕복, 한글 입력+Enter
- 프레임: 같은 출처 iframe, 플러그인 iframe 표시·클릭·입력·`confirm`·재접속 복원·닫기, 가려진 요소 안 누르기
- 터치: 아이콘(SVG) 버튼, 누른 자리 그대로 누르기, click만 오는 입력칸 포커스
- 파일·복사·드래그: 파일 가져오기, 내보내기, 복사, 드래그 앤 드롭
- 그 밖: 서식 편집기, 우클릭·길게 누르기, 새 창, 알림, 안내 상자 위치, 소리·TTS, 캔버스, 호버, 클립보드 읽기, 다른 폰 접속 시 넘겨주기, nginx 뒤 스트림 버퍼링

맥에서는 `CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test`.

## 알려진 한계
- 미러 로그인은 HTTP라면 비밀번호가 평문으로 오가요. 밖에서 쓸 때는 nginx 등으로 HTTPS를 붙여 주세요.
- 플러그인 켜짐 상태는 브라우저마다 따로 저장돼요. 서버 Chrome의 플러그인은 미러 화면에서 켜고 꺼야 해요.
- 헤드리스 Chrome에서 별도 프로세스 iframe에 실제 키 이벤트를 보내면 그 뒤 마우스가 iframe에 닿지 않아요. 그래서 iframe 안의 키는 그 프레임에서 `KeyboardEvent`를 직접 만들어요(`isTrusted`가 false).
- CSSOM으로 넣은 스타일(insertRule, adoptedStyleSheets)·Shadow DOM은 미러되지 않음(PocketRisu·RisuBard 소스에는 없음).
- 동시에 여러 폰은 못 써요(마지막에 연 폰이 씀).
- 터치 전용 처리기(touchstart)는 서버에 마우스로 전달되므로 동작하지 않음. 앱이 마우스 경로도 갖고 있으면 문제없음.
- 서식 편집기는 글자(textContent)만 동기화. 서식 붙여넣기는 글자만 남음.
