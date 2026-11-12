# core-poc/prompt: 리수 프롬프트 조립을 화면 없이 돌리기

리수 원본 `sendChat`을 그대로 돌리고, 실제 전송 함수(`requestChatData`)만 바꿔 끼워 AI에게 보내기 직전의 프롬프트를 가로채요.

## 구성
- **실제 리수 코드**: `process/index.svelte.ts`(sendChat), `lorebook`, `scripts`(정규식), `exampleMessages`, `prompt`, `chatML`, `group`, `parser`, `cbs`, `chatVar`, `infunctions`, `util`, `storage/database.svelte`, `defaultPrompts`, `templates`, `model/types`에 외부 라이브러리 `@risuai/ccardlib` 0.4.2(kwaroran/CCardLib)까지 포함해요.
- **손으로 쓴 대체 모듈**(`manual.json.js`): 저장소 상태, 토크나이저(근사값), 전송 함수(가로채기), 모델 정보, 모듈 시스템(빈 목록), Lua·트리거(그대로 통과), 플러그인 훅(빈 집합), 멀티유저 동기화(혼자 쓰는 상태)예요.
- **자동 빈 모듈**: 화면, 네트워크, 기억(hypa/supa), TTS, 이미지 처리 등 약 50개예요.
- **호스트 폴리필**(`host-polyfills.js`): 네이티브 앱이 JSContext에 넣어 줘야 하는 웹 API 목록이에요. 지금은 `AbortController` 하나뿐이에요.

## 결과 (2026-11-12)
- 리수 순서대로 조립된 프롬프트를 얻었어요(`prompt.sandbox.txt`). 메인 프롬프트, 설명, 성격, 상황, 페르소나, 예시 대화, 첫 메시지, 대화, 로어북, 작가 노트가 모두 들어 있어요.
- 로어북은 키워드에 걸린 항목만 켜지고 무관한 항목은 빠졌어요.
- 정규식(`editprocess`)이 대화 메시지에 적용됐어요(금서고 → 禁書庫). 대화 속 CBS(`{{calc::2+3}}` → 5)도 처리됐어요.
- 브라우저 전역이 없는 샌드박스와 일반 Node에서 결과가 바이트 단위까지 같아요.

## 아직 확인 못 한 것
- **실제 리수 웹에서 같은 데이터로 만든 프롬프트와의 대조**를 아직 못 했어요. 지금은 "원본 코드가 끝까지 돌았다"는 것까지만 확인한 상태예요.
- 토크나이저가 근사값이라 긴 대화에서 잘리는 지점이 원본과 다를 수 있어요.
- 응답을 받은 뒤의 후처리 단계에서 오류가 나요(응답 형식이 가짜라서 생기는 것). 프롬프트 조립과는 무관해요.
- 실제 iOS JavaScriptCore에서는 아직 실행하지 않았어요.
