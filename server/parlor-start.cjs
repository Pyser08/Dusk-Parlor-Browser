#!/usr/bin/env node
// Dusk Parlor 실행기 — 리스와 미러를 한 명령으로 함께 켠다. (Dusk Cellar 실행기와 같은 방식)
//
// 리스 폴더/Dusk-Parlor/ 에 두고:
//   node Dusk-Parlor/parlor-start.cjs           리스 폴더에서
//   pm2 start Dusk-Parlor/parlor-start.cjs --name risu   pm2로 쓸 때(리스 대신 이 파일을 등록)
//   -- 뒤의 인자는 리스(또는 Dusk Cellar 실행기)에 그대로 넘긴다
//
// 동작:
//   · 리스를 안쪽 포트(기본 7778)로 켠다. Dusk Cellar가 설치돼 있으면(리스 폴더/Dusk-Cellar/cellar-start.cjs)
//     Cellar 실행기를 대신 켠다 → 리스·Cellar·미러가 함께 돈다.
//   · 리스가 응답하면 미러를 바깥 포트(기본 7777, 원래 리스 포트)에 켠다.
//       http://<서버>:7777/           → 리스 그대로
//       http://<서버>:7777/__parlor/  → 미러(폰)
//   · 리스가 꺼지면 미러도 끄고 같은 종료 코드로 끝낸다(pm2가 재시작을 맡는다).
//   · 미러만 죽으면 미러만 다시 켠다(점점 늦게).
//   · Chrome을 못 구하거나 Node가 22 미만이면 미러 없이 리스를 원래 포트로 켠다(리스는 늘 쓸 수 있게).
//   · 설정: 이 파일 옆 parlor.json { port, risuPort, chromeBin, host }. 데이터: 이 파일 옆 data/
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { findChrome, downloadChrome } = require("./chrome-get.cjs");

const log = (...a) => console.log("[parlor]", ...a);
const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const pass = dash < 0 ? [] : argv.slice(dash + 1);

let conf = {};
try { conf = JSON.parse(fs.readFileSync(path.join(__dirname, "parlor.json"), "utf8")); } catch { /* 기본값 */ }
const PORT = String(conf.port || process.env.PARLOR_PORT || 7777);
const RISU_PORT = String(conf.risuPort || process.env.RISU_PORT || 7778);
const HOST = conf.host || "0.0.0.0";
const dataDir = path.join(__dirname, "data");

function findRisuRoot() {
  for (const d of [path.dirname(__dirname), process.cwd()]) {
    if (fs.existsSync(path.join(d, "server", "node", "server.cjs"))) return d;
  }
  return null;
}
const risuRoot = findRisuRoot();
if (!risuRoot) { log("리스 폴더를 못 찾았어요. Dusk-Parlor 폴더를 리스 폴더(server/node/server.cjs가 있는 곳) 안에 두세요."); process.exit(1); }
const cellar = path.join(risuRoot, "Dusk-Cellar", "cellar-start.cjs");
const entry = fs.existsSync(cellar) ? cellar : path.join(risuRoot, "server", "node", "server.cjs");

let risu = null, mirror = null, stopping = false, mirrorTries = 0;

function startRisu(port) {
  log(`리스 켜는 중 → ${port} 포트${entry === cellar ? " (Dusk Cellar 실행기로)" : ""}`);
  risu = spawn(process.execPath, [entry, ...pass], { cwd: risuRoot, stdio: "inherit", env: { ...process.env, PORT: port, DUSK_PARLOR_LAUNCHER: "1" } });
  risu.on("exit", (code, sig) => {
    stopping = true;
    if (mirror) mirror.kill();
    log(`리스가 꺼졌어요(${sig || code}).`);
    process.exit(code ?? 1);
  });
}

const ping = (port) => new Promise((ok) => {
  const q = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (r) => { r.resume(); ok(true); });
  q.on("error", () => ok(false)); q.on("timeout", () => { q.destroy(); ok(false); });
});

function startMirror(chrome) {
  if (stopping) return;
  mirror = spawn(process.execPath, [path.join(__dirname, "src", "cli.mjs")], {
    stdio: "inherit",
    env: { ...process.env, PARLOR_TARGET: `http://127.0.0.1:${RISU_PORT}`, PARLOR_PORT: PORT, PARLOR_HOST: HOST, CHROME_BIN: chrome, PARLOR_PROFILE: path.join(dataDir, "profile"), PARLOR_DUSK: conf.dusk === false ? "0" : "1" },
  });
  const started = Date.now();
  mirror.on("exit", (code, sig) => {
    mirror = null;
    if (stopping) return;
    if (Date.now() - started > 60000) mirrorTries = 0;   // 한동안 잘 돌았으면 다시 처음부터 센다
    const wait = Math.min(60000, 2000 * 2 ** mirrorTries++);
    log(`미러가 꺼졌어요(${sig || code}). ${Math.round(wait / 1000)}초 뒤 다시 켜요.`);
    setTimeout(() => startMirror(chrome), wait);
  });
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  let chrome = null, why = "";
  if (Number(process.versions.node.split(".")[0]) < 22) why = `Node가 ${process.versions.node}예요(22 이상 필요)`;
  else {
    chrome = (conf.chromeBin && fs.existsSync(conf.chromeBin) && conf.chromeBin) || findChrome(__dirname);
    if (!chrome) {
      try { chrome = await downloadChrome(__dirname, log); } catch (e) { why = "Chrome을 구하지 못했어요: " + e.message; }
    }
  }
  if (!chrome) {
    log(`미러 없이 리스만 켜요 — ${why}`);
    startRisu(PORT);
    return;
  }
  startRisu(RISU_PORT);
  for (let i = 0; i < 240 && !stopping; i++) {
    if (await ping(RISU_PORT)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (stopping) return;
  log(`미러 켜는 중 → ${PORT} 포트 (Chrome: ${chrome})`);
  log(`  리스: http://<서버>:${PORT}/   미러: http://<서버>:${PORT}/__parlor/`);
  startMirror(chrome);
}

for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(s, () => {
    stopping = true;
    if (mirror) mirror.kill(s);
    if (risu) risu.kill(s); else process.exit(0);
  });
}
main().catch((e) => { log("실행기 오류:", e?.stack || e); process.exit(1); });
