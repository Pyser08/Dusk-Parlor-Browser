#!/usr/bin/env bash
# Dusk Parlor 설치 (리눅스·맥). 리스 폴더(server/node/server.cjs가 있는 곳)에서:
#   curl -fsSL https://raw.githubusercontent.com/Pyser08/Dusk-Parlor-Browser/mirror/server/install.sh | bash
#   bash install.sh [리스 폴더] [parlor-setup 옵션…]   (--no-pm2, --port 7777, --risu-port 7778)
# 다시 실행하면 최신으로 바뀌어요(data/·parlor.json은 그대로).
set -e
REPO="${DUSK_PARLOR_REPO:-https://github.com/Pyser08/Dusk-Parlor-Browser}"
REF="${DUSK_PARLOR_REF:-mirror}"
ARCHIVE="${DUSK_PARLOR_ARCHIVE:-$REPO/archive/refs/heads/$REF.tar.gz}"
say() { printf '\n%s\n' "$*"; }
die() { printf '\n[실패] %s\n' "$*" >&2; exit 1; }

DIR="$PWD"
if [ -n "${1:-}" ] && [ -d "$1" ]; then DIR="$(cd "$1" && pwd)"; shift; fi
cd "$DIR"
[ -f server/node/server.cjs ] || die "리스 폴더가 아니에요: $DIR (server/node/server.cjs가 있는 폴더에서 실행해 주세요)"
say "설치 위치: $DIR/Dusk-Parlor"

# Node: 리스에 들어 있는 bin/node 우선, 없으면 시스템 Node(22 이상)
NODE=""
if [ -x ./bin/node ]; then NODE="$DIR/bin/node"
elif command -v node >/dev/null 2>&1; then NODE="$(command -v node)"
else die "Node.js를 못 찾았어요. Node.js 22 이상을 설치해 주세요 (https://nodejs.org)"; fi
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js가 낮아요($("$NODE" -v)). 22 이상이 필요해요."

command -v curl >/dev/null 2>&1 || die "curl이 없어요"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say "내려받는 중… ($ARCHIVE)"
curl -fsSL "$ARCHIVE" -o "$TMP/p.tgz" || die "내려받기에 실패했어요"
mkdir "$TMP/x" && tar -xzf "$TMP/p.tgz" -C "$TMP/x" || die "압축을 풀지 못했어요"
SRC="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)/server"
[ -f "$SRC/parlor-setup.cjs" ] || die "받은 파일이 올바르지 않아요"
mkdir -p Dusk-Parlor
(cd "$SRC" && tar -cf - .) | (cd Dusk-Parlor && tar -xf -)
cd Dusk-Parlor
"$NODE" parlor-setup.cjs "$@"
