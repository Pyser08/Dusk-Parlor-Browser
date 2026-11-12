# Dusk Parlor Browser

> 라이선스: GPL-3.0. 앱에 RisuAI(GPL-3.0) 코드를 묶어 넣기 때문이에요.

RisuAI와 그 포크(RisuBard, PocketRisu) 전용 브라우저. 지금은 iOS 뼈대(v0.1.0)만 있어요.

## 지금 들어 있는 것 (iOS)
- **사이트 목록**: 기본값은 `Resources/sites.json`, 앱 안에서 https 주소를 추가하거나 지울 수 있어요.
- **허용 목록**: 상단 프레임은 등록한 호스트로만 이동해요. 그 밖의 링크는 Safari로 넘기고, 새 창은 열지 않아요.
- **저장소 분리**: 사이트마다 따로 저장소(`WKWebsiteDataStore(forIdentifier:)`)를 써서 쿠키나 IndexedDB가 섞이지 않아요.
- **잠금**: 카메라·마이크 요청은 거절해요. 링크 미리보기와 데이터 감지는 꺼 두었고, 릴리스 빌드에서는 웹 인스펙터도 꺼져요. 미디어는 자동 재생하지 않아요.
- **OOM 복구**: 웹 프로세스가 종료되면 마지막 주소로 다시 띄우고, 입력창 초안을 복원해요.
- **메모리 경고**: 경고가 오면 페이지에 `dusk-memory-warning` 이벤트를 보내요.
- **다운로드**: 받은 파일을 공유 시트로 넘겨요.
- **크래시 기록**: 콘솔 오류, 잡히지 않은 예외, 200ms 넘게 걸린 작업을 플러그인 iframe까지 포함해 모아 둬요. 웹 프로세스가 죽으면 '파일' 앱의 Dusk Parlor Browser > crashlogs에 저장해요. 최근 20개까지 보관해요.
- **기기**: iPhone과 iPad 모두 지원해요.
- **디버그 HUD**: 세 손가락으로 두 번 탭하면 앱 메모리, 경고 횟수, 웹 크래시 횟수를 보여 줘요.

## 빌드
```sh
brew install xcodegen
cd ios && xcodegen generate && open DuskParlor.xcodeproj
```
CI(`.github/workflows/ios.yml`)는 `v*` 태그를 푸시하면 서명 없는 IPA를 릴리스에 붙여요. AltStore 소스는 `altstore/source.json`이에요.

## 다음 단계
1. 실제 기기에서 HUD로 크래시 지점 측정하기
2. 에셋 커스텀 스킴(`WKURLSchemeHandler`)과 네이티브 저장 브리지
3. 데스크톱(Tauri) 셸

## 라이선스
All rights reserved. 저작권자(Pyser08)의 허락 없이 복제, 수정, 배포, 이용할 수 없어요. 자세한 내용은 `LICENSE`를 보세요.
