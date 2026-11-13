// Chrome 찾기·받기 (맥·윈도우·리눅스). Node 기본 기능만 쓴다.
//   findChrome(base)     이미 있는 Chrome 경로(없으면 null)
//   downloadChrome(base) Google의 Chrome for Testing 헤드리스 판을 <base>/chrome/ 에 받는다(관리자 권한 불필요)
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");

const CFT = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

function platformKey() {
  const p = process.platform, a = process.arch;
  if (p === "darwin") return a === "arm64" ? "mac-arm64" : "mac-x64";
  if (p === "win32") return a === "ia32" ? "win32" : "win64";
  if (p === "linux") return a === "arm64" ? "linux-arm64" : "linux64";
  return null;
}

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
function which(cmd) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    for (const ext of process.platform === "win32" ? [".exe", ""] : [""]) {
      const f = path.join(dir, cmd + ext);
      if (isFile(f)) return f;
    }
  }
  return null;
}

function downloadedPath(base) {
  const key = platformKey();
  if (!key) return null;
  const exe = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  return path.join(base, "chrome", `chrome-headless-shell-${key}`, exe);
}

function findChrome(base) {
  const cands = [process.env.CHROME_BIN];
  if (process.platform === "darwin") {
    cands.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
      if (root) cands.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else {
    for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) cands.push(which(c));
  }
  if (base) cands.push(downloadedPath(base));
  // 윈도우에는 Edge(크로미움)가 늘 있으니 마지막 대안으로 쓴다
  if (process.platform === "win32") {
    for (const root of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
      if (root) cands.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  }
  return cands.find((c) => c && isFile(c)) || null;
}

function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tries = process.platform === "darwin" ? [["ditto", ["-x", "-k", zip, dest]], ["unzip", ["-qo", zip, "-d", dest]]]
    : process.platform === "win32" ? [["tar.exe", ["-xf", zip, "-C", dest]], ["powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${dest}'`]]]
    : [["unzip", ["-qo", zip, "-d", dest]], ["bsdtar", ["-xf", zip, "-C", dest]], ["python3", ["-m", "zipfile", "-e", zip, dest]]];
  for (const [cmd, args] of tries) {
    try { execFileSync(cmd, args, { stdio: "ignore" }); return; } catch { /* 다음 방법 */ }
  }
  throw new Error("압축을 풀 도구가 없어요(unzip 또는 python3를 설치해 주세요)");
}

async function downloadChrome(base, log = console.log) {
  const key = platformKey();
  if (!key) throw new Error(`이 운영체제(${process.platform}/${process.arch})용 Chrome은 자동으로 받을 수 없어요`);
  const meta = await (await fetch(CFT)).json();
  const stable = meta.channels.Stable;
  const item = stable.downloads["chrome-headless-shell"].find((d) => d.platform === key);
  if (!item) throw new Error(`Chrome for Testing에 ${key} 판이 없어요`);
  log(`Chrome ${stable.version} (${key}) 받는 중…`);
  const dir = path.join(base, "chrome");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, "chrome.zip");
  const r = await fetch(item.url);
  if (!r.ok) throw new Error(`내려받기 실패(${r.status})`);
  fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  unzip(zip, dir);
  fs.rmSync(zip, { force: true });
  const exe = downloadedPath(base);
  if (!isFile(exe)) throw new Error("받은 Chrome에서 실행 파일을 찾지 못했어요");
  if (process.platform !== "win32") fs.chmodSync(exe, 0o755);
  return exe;
}

// 실제로 한 번 띄워 본다. 리눅스 서버는 Chrome이 쓰는 라이브러리가 없어서 못 뜨는 일이 많다.
function checkChrome(exe) {
  const headless = /headless-shell/i.test(path.basename(exe)) ? "--headless" : "--headless=new";
  const args = [headless, "--disable-gpu", "--dump-dom", "about:blank", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: 60000 });
  if (r.status === 0) return { ok: true };
  const err = String(r.stderr || r.error?.message || "").trim().split("\n").slice(-3).join("\n");
  return { ok: false, err, missingLibs: /shared libraries|cannot open shared object/i.test(err) };
}

// Debian·Ubuntu에서 헤드리스 Chrome이 쓰는 라이브러리 설치(우분투 24.04는 이름 끝에 t64가 붙는다)
const LIBS = ["libatk1.0-0", "libatk-bridge2.0-0", "libcups2", "libasound2", "libxkbcommon0", "libxcomposite1", "libxdamage1", "libxfixes3", "libxrandr2", "libgbm1", "libpango-1.0-0", "libcairo2", "libnss3", "libnspr4", "libdrm2", "libxshmfence1", "fonts-noto-cjk"];
const T64 = new Set(["libatk1.0-0", "libatk-bridge2.0-0", "libcups2", "libasound2"]);
function installLinuxLibs(log = console.log) {
  if (process.platform !== "linux") return false;
  let apt = false; try { execFileSync("apt-get", ["--version"], { stdio: "ignore" }); apt = true; } catch {}
  if (!apt) return false;
  const root = process.getuid?.() === 0;
  const run = (pkgs) => {
    const cmd = root ? "apt-get" : "sudo";
    const a = root ? ["install", "-y", ...pkgs] : ["apt-get", "install", "-y", ...pkgs];
    try { execFileSync(cmd, a, { stdio: "inherit", env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } }); return true; } catch { return false; }
  };
  log("Chrome에 필요한 라이브러리를 설치해요(관리자 암호를 물을 수 있어요)…");
  if (run(LIBS.map((n) => (T64.has(n) ? n + "t64" : n)))) return true;
  return run(LIBS);
}

module.exports = { findChrome, downloadChrome, checkChrome, installLinuxLibs, platformKey };
