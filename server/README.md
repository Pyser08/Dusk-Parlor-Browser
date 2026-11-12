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

의존 패키지 없음(Node 22 이상 + Chrome).

## 동작 방식
- 서버→폰: 첫 화면 전체(`snap`) 후 `kids`(자식 목록 변경)·`attr`·`text`·`val`(입력값)·`scroll`만 전송. `<script>`·`on*` 속성은 보내지 않음.
- 폰→서버: 클릭은 CDP 실제 마우스 입력(가려져 있으면 `el.click()`), 입력값은 조합(한글) 끝난 뒤 전송, Enter·Esc·Tab·방향키는 키 이벤트로 전달. 순서 보장을 위해 양쪽 모두 한 줄로 처리.
- `blob:` 이미지는 `/__parlor/blob`으로 서버 페이지에서 꺼내 전달. 그 밖의 정적 파일(CSS·폰트·이미지)은 리수 서버로 프록시.

## 시험
`npm test` — 가짜 리수 페이지로 첫 화면·스크립트 차단·CSS 프록시·blob 이미지·클릭 왕복·한글 입력+Enter 전송·토큰 검사를 Chrome 두 개로 확인.

## 알려진 한계
- 실제 리수에서는 아직 안 돌려 봄.
- CSSOM으로 넣은 스타일(insertRule, adoptedStyleSheets)·캔버스·Shadow DOM은 미러되지 않음 → Svelte 전환 애니메이션 정도가 빠질 수 있음.
- 파일 업로드·다운로드·클립보드 연동, 접속자별 분리(지금은 모든 폰이 탭 하나를 공유) 미구현.
- 드래그·길게 누르기·호버 등 클릭 외 포인터 동작 미구현.
