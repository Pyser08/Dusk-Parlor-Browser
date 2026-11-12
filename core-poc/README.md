# core-poc: 리수 CBS 엔진을 화면 없이 돌리기

혼합형 앱의 첫 관문 시험이에요. 리수의 `risuChatParser`(CBS)를 DOM 없는 JS 환경에서 돌려 원본과 결과가 같은지 확인해요.

- `build.js`: 리수 소스(`/home/claude/risu-src`, kwaroran/RisuAI)에서 `cbs.ts`, `parser.svelte.ts`, `chatVar.svelte.ts`, `infunctions.ts`, `model/types.ts`만 실제 코드로 쓰고, 나머지는 `stubs.js`의 가짜 모듈로 바꿔 IIFE 하나로 묶어요. Bun이 필요해요.
- 호스트(네이티브 앱)는 `globalThis.__risu = { db, selId }`로 데이터를 넣어 줘요.
- 필요한 폴리필은 둘이에요. Svelte `$effect`는 빈 함수로, `safeStructuredClone`은 JSON 복제로 대신해요. 에셋 캐시는 호스트가 `resetAssetsCache`를 직접 불러 갱신해요.
- `run.mjs`: window, document, fetch, setTimeout, TextEncoder가 없는 샌드박스에서 리수 자체 CBS 테스트의 리터럴 기대값과 대조해요.

## 결과 (2026-11-12)
- 대조한 67건은 원본과 같고, 1건이 달라요.
- 다른 1건(`{{cbr::3}}`)은 전역이 다 있는 일반 Node에서도 똑같이 나와요(`crosscheck.mjs`). 엔진 차이가 아니라 리수 코드 자체의 버그예요.
- 무작위 생성 테스트(fast-check) 71건은 의존성을 받지 못해 건너뛰었어요.
- 실제 iOS JavaScriptCore에서는 아직 돌려 보지 않았어요.
