#!/usr/bin/env node
// Dusk Parlor 설치 마무리 (install.sh / install.command / install.bat가 부른다). 다시 실행해도 안전.
//   1. 리스 폴더 찾기 (이 폴더의 위 = 리스 폴더)
//   2. Chrome 찾기 → 없으면 Chrome for Testing 헤드리스 판을 이 폴더에 받기
//   3. parlor.json 만들기(있으면 그대로)
//   4. pm2가 있으면: 리스(또는 Dusk Cellar 실행기) pm2 항목은 그대로 두고 포트만 안쪽으로 옮긴 뒤, 미러를 별도 pm2 'dusk-parlor'로 등록
//      pm2가 없으면: 리스 폴더에 start_parlor(.command/.bat/.sh) 만들기
// 옵션: --no-pm2  pm2를 건드리지 않음 · --port 7777 · --risu-port 7778
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { findChrome, downloadChrome } = require("./chrome-get.cjs");

const say = (...a) => console.log("[parlor]", ...a);
const die = (m) => { console.error("[실패]", m); process.exit(1); };
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const WIN = process.platform === "win32";

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) die(`Node ${process.versions.node}예요. 22 이상이 필요해요.`);
  const risuRoot = path.dirname(__dirname);
  if (!fs.existsSync(path.join(risuRoot, "server", "node", "server.cjs"))) die(`리스 폴더가 아니에요: ${risuRoot} (server/node/server.cjs가 있는 폴더에서 설치해 주세요)`);
  say("리스 폴더:", risuRoot);
  if (fs.existsSync(path.join(risuRoot, "Dusk-Cellar", "cellar-start.cjs"))) say("Dusk Cellar가 있어요 → 그대로 함께 돌아요.");

  // Chrome
  let chrome = findChrome(__dirname);
  if (!chrome) {
    try { chrome = await downloadChrome(__dirname, say); } catch (e) { die("Chrome을 받지 못했어요: " + e.message + "\n  Chrome을 설치한 뒤 다시 실행하거나 CHROME_BIN에 경로를 넣어 주세요."); }
  }
  say("Chrome:", chrome);

  // 설정
  const confFile = path.join(__dirname, "parlor.json");
  let conf = {};
  try { conf = JSON.parse(fs.readFileSync(confFile, "utf8")); } catch { /* 처음 */ }
  conf.port = Number(opt("--port", conf.port || 7777));
  conf.risuPort = Number(opt("--risu-port", conf.risuPort || 7778));
  conf.chromeBin = chrome;
  fs.writeFileSync(confFile, JSON.stringify(conf, null, 2) + "\n");

  const pm2 = args.includes("--no-pm2") ? null : findPm2();
  if (pm2) registerPm2(pm2, conf, chrome, risuRoot);
  else makeStartFiles(risuRoot);

  say("끝났어요.");
  say(`  리스(PC): http://<서버>:${conf.port}/`);
  say(`  미러(폰): http://<서버>:${conf.port}/__parlor/   (처음 한 번 리스 비밀번호, 서버 Chrome은 미러 화면에서 리스 로그인 한 번)`);
}

function findPm2() {
  try { execFileSync(WIN ? "pm2.cmd" : "pm2", ["-v"], { stdio: "ignore", shell: WIN }); return WIN ? "pm2.cmd" : "pm2"; } catch { return null; }
}
const run = (pm2, a) => execFileSync(pm2, a, { stdio: ["ignore", "pipe", "inherit"], shell: WIN, encoding: "utf8" });

// pm2: 리스(또는 Dusk Cellar 실행기) 항목은 그대로 두고 포트만 안쪽(risuPort)으로 옮긴 뒤, 미러는 따로 'dusk-parlor'로 등록
function registerPm2(pm2, conf, chrome, risuRoot) {
  let list = [];
  try { const out = run(pm2, ["jlist"]); list = JSON.parse(out.slice(out.indexOf("["))); } catch { /* 비어 있음 */ }
  const norm = (p) => path.resolve(String(p || "")).toLowerCase();
  const risuFiles = new Set([norm(path.join(risuRoot, "server", "node", "server.cjs")), norm(path.join(risuRoot, "Dusk-Cellar", "cellar-start.cjs"))]);
  const risu = list.filter((p) => risuFiles.has(norm(p.pm2_env?.pm_exec_path)));
  if (!risu.length) die("pm2에서 이 리스를 켜는 항목을 못 찾았어요. 리스를 pm2로 켜 둔 뒤 다시 실행하거나, --no-pm2로 설치해 주세요.");
  for (const p of risu) {
    say(`pm2 '${p.name}'의 리스 포트를 ${conf.risuPort}로 옮겨요`);
    execFileSync(pm2, ["restart", String(p.pm_id), "--update-env"], { stdio: "ignore", shell: WIN, env: { ...process.env, PORT: String(conf.risuPort) } });
  }
  // 미러 pm2 설정(값은 JSON으로 넣어 경로에 어떤 글자가 있어도 안전)
  const eco = path.join(__dirname, "data", "pm2.config.cjs");
  fs.mkdirSync(path.dirname(eco), { recursive: true });
  const app = {
    name: "dusk-parlor", script: path.join(__dirname, "src", "cli.mjs"), cwd: __dirname, interpreter: process.execPath,
    autorestart: true, restart_delay: 3000, max_memory_restart: "3G",
    env: { PARLOR_TARGET: `http://127.0.0.1:${conf.risuPort}`, PARLOR_PORT: String(conf.port), PARLOR_HOST: "0.0.0.0", CHROME_BIN: chrome, PARLOR_PROFILE: path.join(__dirname, "data", "profile") },
  };
  fs.writeFileSync(eco, "// parlor-setup.cjs가 만든 파일. 다시 설치하면 덮어써요.\nmodule.exports = " + JSON.stringify({ apps: [app] }, null, 2) + ";\n");
  if (list.some((p) => p.name === "dusk-parlor")) run(pm2, ["delete", "dusk-parlor"]);
  run(pm2, ["start", eco]);
  run(pm2, ["save"]);
  say("미러를 pm2 'dusk-parlor'로 등록했어요. 로그: pm2 logs dusk-parlor");
  say("재부팅 뒤 자동 실행이 아직이면 'pm2 startup'이 알려 주는 명령을 한 번 실행해 주세요.");
}

function makeStartFiles(risuRoot) {
  const portable = fs.existsSync(path.join(risuRoot, "bin", WIN ? "node.exe" : "node"));
  if (WIN) {
    const node = portable ? '"%~dp0bin\\node.exe"' : "node";
    fs.writeFileSync(path.join(risuRoot, "start_parlor.bat"), `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\n${node} Dusk-Parlor\\parlor-start.cjs %*\r\npause\r\n`);
    say("리스 폴더에 실행 파일을 만들었어요: start_parlor.bat — 앞으로는 이걸 더블클릭해서 켜세요(리스 원래 실행 파일 대신).");
  } else {
    const node = portable ? '"$(dirname "$0")/bin/node"' : "node";
    const body = `#!/usr/bin/env bash\ncd "$(dirname "$0")" || exit 1\nexec ${node} Dusk-Parlor/parlor-start.cjs "$@"\n`;
    const file = path.join(risuRoot, process.platform === "darwin" ? "start_parlor.command" : "start_parlor.sh");
    fs.writeFileSync(file, body, { mode: 0o755 });
    say(`리스 폴더에 실행 파일을 만들었어요: ${path.basename(file)} — 앞으로는 이걸로 켜세요(리스 원래 실행 파일 대신).`);
  }
}

main().catch((e) => die(e?.stack || String(e)));
