# 설계: iframe(플러그인 창) 미러링

상태: 구현됨 (2026-11-13). 시험 8~13번. 실제 플러그인 창으로는 아직 확인 안 함.

구현하며 바뀐 점:
- 키 입력: 별도 프로세스 iframe에 `Input.dispatchKeyEvent`를 보내면 그 뒤 마우스 입력이 iframe에 닿지 않았다(헤드리스 Chrome, 탭 세션·자식 세션 모두). 그래서 iframe 안의 키는 `__parlor.key()`로 그 프레임에서 `KeyboardEvent`를 만든다.
- 에이전트가 실행 맥락 등록보다 먼저 메시지를 보낼 수 있어서, 서버가 맥락별로 잠시 보관했다가 등록되면 보낸다.
- 부모 프레임 키는 각 문서의 `window.__parlorKey`로 알아낸다(`DOM.resolveNode` 결과에 맥락 id가 없음).

## 문제
리수 플러그인 v3는 UI를 **샌드박스 iframe**으로 띄운다.
PocketRisu에서 Dusk Atelier를 켰을 때 실제로 본 모양:

```html
<iframe srcdoc="…" sandbox="allow-scripts allow-modals allow-downloads"
        style="position:fixed; inset:0; z-index:1000">   <!-- 화면 전체를 덮음 -->
```

지금 미러는 최상위 문서만 보낸다(`agent.js`의 `window !== window.top` 검사). 그래서 두 가지가 깨진다.
1. 폰에는 플러그인 창이 안 보인다(빈 iframe 자리만 남음).
2. 서버에서는 iframe이 위를 덮고 있어서, 폰에서 누른 클릭이 아래 리수 화면에 닿지 않는다.

## 실험으로 확인한 사실 (헤드리스 Chrome, 맥)
| 확인 | 결과 |
|---|---|
| `allow-same-origin` 없는 샌드박스 srcdoc iframe의 정체 | **별도 프로세스 타깃(OOPIF)**. 메인 세션의 `Page.getFrameTree`·실행 맥락에 안 보임 |
| 붙는 방법 | 메인 세션에서 `Target.setAutoAttach {autoAttach, flatten}` → `Target.attachedToTarget`(type `iframe`)로 자식 세션을 받음. 자식 세션에서 `Runtime.evaluate` 가능 (origin은 `null`) |
| iframe 요소 ↔ 프레임 짝짓기 | 자식 세션 `Page.getFrameTree`의 frameId로, **메인 세션**에서 `DOM.getFrameOwner` → `DOM.resolveNode` → 해당 `<iframe>` 요소를 얻음 |
| 클릭 | 메인 세션에 화면 좌표로 `Input.dispatchMouseEvent`를 보내면 iframe 안 버튼까지 전달됨 (브라우저가 알아서 라우팅) |

같은 출처 iframe(예: `allow-same-origin`이 있는 srcdoc)은 OOPIF가 아니고 메인 세션 안의 다른 실행 맥락으로 돈다. 이번 로그인 후 빈 화면 버그가 이 경우였다. 두 경우를 모두 다뤄야 한다.

## 설계

### 1. 프레임 단위 에이전트
- `agent.js`를 **모든 프레임**에서 다시 실행한다. 최상위 검사를 지우고, 대신 내보내는 모든 메시지에 **프레임 ID**를 붙인다.
  - 에이전트는 자기 frameId를 모르므로 서버가 붙인다.
    - 같은 프로세스 프레임: `Runtime.bindingCalled.executionContextId` → `executionContextCreated.auxData.frameId`로 매핑한다.
    - OOPIF: 그 프레임 세션에서 온 바인딩 호출이므로 세션 → frameId로 매핑한다.
- 서버 → 폰 메시지 형식: `[{ f: '<frameKey>', ops: [...] }]`. 최상위는 `f: 'top'`. `frameKey`는 서버가 frameId를 짧은 번호로 바꾼 값이다(내부 ID를 폰에 노출하지 않으려고).

### 2. OOPIF 붙이기 (서버)
```
메인 세션: Target.setAutoAttach { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }
attachedToTarget(type=iframe) 마다:
  자식 세션에 Runtime.addBinding(__parlorEmit), Page.addScriptToEvaluateOnNewDocument(agent),
  Runtime.enable, Page.enable, 다시 Target.setAutoAttach (중첩 iframe)
  → Runtime.runIfWaitingForDebugger
detachedFromTarget / Page.frameDetached → 해당 프레임 상태 정리 + 폰에 { f, gone: true }
```
`waitForDebuggerOnStart`로 멈춰 두는 이유: 플러그인 스크립트가 DOM을 만들기 **전에** 에이전트를 심어야 첫 화면부터 미러가 맞는다.

### 3. iframe 요소와 내용 연결
- 메인 프레임 에이전트는 `<iframe>`을 지금처럼 요소로 직렬화한다. 다만 `srcdoc`·`src`는 빼고 `data-parlor-frame` 자리표시만 남긴다(폰이 원래 문서를 직접 불러오면 안 되니까).
- 서버는 프레임이 붙을 때 `DOM.getFrameOwner`로 소유 `<iframe>`을 찾고, 그 요소의 에이전트 노드 id를 얻는다. 이 id는 `Runtime.callFunctionOn`으로 `__parlor.idOf(this)`를 불러서 얻는다. 그다음 폰에 `{ op: 'frame', owner: <노드 id>, f: <frameKey> }`를 보낸다.
- 순서가 꼬일 수 있다. 자식 스냅샷이 owner 연결보다 먼저 오면 폰이 frameKey별로 잠깐 쌓아 뒀다가 연결될 때 적용한다.

### 4. 폰 쪽 그리기
- 폰의 `<iframe>`은 `src` 없이 **`sandbox="allow-same-origin"`(스크립트 불허)** 로 만든다.
  - 같은 출처이므로 부모의 `mirror.js`가 `iframe.contentDocument`에 직접 그릴 수 있다.
  - `allow-scripts`가 없으니 플러그인 HTML에 스크립트가 섞여 와도 폰에서 실행되지 않는다(이중 안전장치. 에이전트도 원래 `<script>`·`on*`을 빼고 보냄).
- `mirror.js`의 노드 표(`nodes`, `idOf`)를 **프레임별 객체**로 나눈다. 지금 코드의 `applySnap`·`apply`·`build`를 `Doc` 클래스로 묶고, 문서 루트만 `iframe.contentDocument`로 바꿔 끼운다.
- 입력 이벤트(클릭·키·입력값·스크롤)는 iframe 문서에도 같은 처리기를 단다. 보낼 때 `f`를 함께 보낸다.

### 5. 폰 → 서버 입력
| 이벤트 | 처리 |
|---|---|
| 클릭 | 서버가 해당 프레임 에이전트에 `point(i)`를 묻는다(프레임 안 좌표). 그 좌표에 소유 iframe의 화면 위치를 더한다. 위치는 `getBoundingClientRect` + border/padding으로 구하고, 중첩이면 위로 반복한다. 그 좌표로 메인 세션 `Input.dispatchMouseEvent`를 보낸다. 가려졌으면 그 프레임 안에서 `el.click()` |
| 입력값·스크롤 | 해당 프레임 세션/맥락에서 `__parlor.apply` |
| 키 | 해당 프레임에서 `focus(i)` 후 메인 세션 `Input.dispatchKeyEvent` (포커스된 프레임으로 전달됨) |

`evaluate`는 `(frameKey, expr)`를 받도록 바꾼다. OOPIF면 그 세션에, 같은 프로세스면 `contextId`를 지정해 실행한다.

### 6. 정적 파일·blob
- srcdoc 안의 상대 경로는 부모 주소 기준이라, 지금 프록시(`/` → 리수 서버)로 그대로 해결된다.
- 샌드박스 프레임의 `blob:` 주소는 그 프레임(origin `null`)에서만 읽힌다. 그래서 `/__parlor/blob?f=<frameKey>&u=…`로 받고, 해당 프레임 에이전트의 `blob()`로 꺼낸다.

### 7. 재연결·스냅샷
폰이 붙으면(`/__parlor/stream`) 최상위 → 각 프레임 순서로 `snap`을 보내고, 모든 `frame` 연결 정보도 다시 보낸다.

### 8. 대화상자 (`allow-modals`)
플러그인은 `alert`/`confirm`을 쓸 수 있다. 지금은 서버에서 뜬 대화상자가 페이지를 멈추게 한다. 함께 처리할 일이다.
- 모든 세션에서 `Page.javascriptDialogOpening` 수신 → 폰에 `{ op: 'dialog', type, message }` → 폰이 네이티브 `confirm()`·`prompt()`로 보여 줌 → 결과를 `POST /__parlor/dialog`로 받아 `Page.handleJavaScriptDialog`로 응답한다.
- 폰 연결이 없으면 일정 시간 뒤 기본값(alert는 확인, confirm은 취소)으로 닫는다.

## 바뀌는 파일
| 파일 | 변경 |
|---|---|
| `src/agent.js` | 최상위 검사 제거, `idOf(node)` 공개, `blob()`은 그대로 |
| `src/mirror-server.mjs` | 프레임 표(frameKey ↔ 세션/맥락/소유 노드), auto-attach, 메시지에 `f` 부착, `evaluate(frameKey, …)`, 클릭 좌표 합성, 대화상자 |
| `client/mirror.js` | `Doc` 단위로 분리, `frame` op 처리, iframe 문서에 입력 처리기 연결, 대기열 |

## 시험 계획 (구현 전에 실패하는 시험부터)
가짜 리수 페이지에 Dusk Atelier처럼 **샌드박스 srcdoc iframe을 화면 전체로** 띄우는 버튼을 둔다.
1. iframe 안 버튼 글자가 폰에 보임
2. 폰에서 iframe 안 버튼을 누르면 서버 iframe에서 클릭되고 결과가 돌아옴
3. iframe 안 입력칸에 한글 입력 → 서버 값과 일치
4. iframe 안 `<script>`는 폰에서 실행되지 않음
5. iframe을 닫으면(요소 제거) 폰에서도 사라지고, 아래 리수 화면 클릭이 다시 됨
6. 폰 새로 접속 시 iframe 내용까지 스냅샷으로 복원
7. 같은 출처 iframe도 화면을 덮어쓰지 않고 제자리에 그려짐 (지금 시험 7의 확장)
8. iframe에서 `confirm()` → 폰에서 답한 값이 서버로 돌아감

## 범위 밖 / 남는 한계
- iframe 안 캔버스·Shadow DOM·CSSOM 스타일은 최상위와 같은 한계를 그대로 가진다.
- 플러그인이 `postMessage`로 리수와 주고받는 건 서버 안에서 일어나므로 신경 쓸 필요 없다.
- 플러그인 켜짐 상태가 브라우저별로 저장되므로, 서버 Chrome의 플러그인 설정은 미러 화면에서 따로 바꿔야 한다(README에 적을 것).
- 실제 Dusk Atelier 화면은 플러그인을 꺼 둔 상태에서 설계했다. 구현 후 플러그인을 켜고 실제 창으로 다시 확인해야 한다.
