@echo off
chcp 65001 >nul
rem Dusk Parlor 설치 (윈도우). 이 파일을 리스 폴더(server\node\server.cjs가 있는 곳)에 넣고 더블클릭하세요.
cd /d "%~dp0"
if not defined DUSK_PARLOR_REPO set DUSK_PARLOR_REPO=https://github.com/Pyser08/Dusk-Parlor-Browser
if not defined DUSK_PARLOR_REF set DUSK_PARLOR_REF=mirror
if not defined DUSK_PARLOR_ARCHIVE set DUSK_PARLOR_ARCHIVE=%DUSK_PARLOR_REPO%/archive/refs/heads/%DUSK_PARLOR_REF%.tar.gz

if not exist "server\node\server.cjs" (echo [실패] 리스 폴더가 아니에요. server\node\server.cjs가 있는 폴더에 넣어 주세요. & pause & exit /b 1)
set "NODE="
if exist "%~dp0bin\node.exe" set "NODE=%~dp0bin\node.exe"
if not defined NODE (
  where node >nul 2>nul && set "NODE=node"
)
if not defined NODE (echo [실패] Node.js를 못 찾았어요. Node.js 22 이상을 설치해 주세요. & pause & exit /b 1)

set "TMPD=%TEMP%\dusk-parlor-%RANDOM%"
mkdir "%TMPD%\x" || (echo [실패] 임시 폴더를 만들지 못했어요. & pause & exit /b 1)
echo 내려받는 중… %DUSK_PARLOR_ARCHIVE%
curl.exe -fsSL "%DUSK_PARLOR_ARCHIVE%" -o "%TMPD%\p.tgz" || (echo [실패] 내려받기에 실패했어요. ^(윈도우 10 이상 필요^) & pause & exit /b 1)
tar.exe -xzf "%TMPD%\p.tgz" -C "%TMPD%\x" || (echo [실패] 압축을 풀지 못했어요. & pause & exit /b 1)
for /d %%d in ("%TMPD%\x\*") do set "SRC=%%d\server"
if not exist "%SRC%\parlor-setup.cjs" (echo [실패] 받은 파일이 올바르지 않아요. & pause & exit /b 1)
if not exist Dusk-Parlor mkdir Dusk-Parlor
xcopy /E /I /Y /Q "%SRC%\*" Dusk-Parlor\ >nul || (echo [실패] 파일을 복사하지 못했어요. & pause & exit /b 1)
rmdir /s /q "%TMPD%" 2>nul

cd Dusk-Parlor
"%NODE%" parlor-setup.cjs %*
pause
