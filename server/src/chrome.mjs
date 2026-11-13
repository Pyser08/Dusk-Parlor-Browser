import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 헤드리스 Chrome을 띄우고 DevTools 주소를 돌려준다.
export async function launchChrome({ bin, userDataDir, extraArgs = [] } = {}) {
  const dir = userDataDir || mkdtempSync(path.join(os.tmpdir(), 'parlor-chrome-'));
  const exe = bin || process.env.CHROME_BIN || 'google-chrome';
  const args = [
    // Chrome for Testing의 헤드리스 전용 판(chrome-headless-shell)은 원래 헤드리스라 '=new'를 쓰지 않는다
    /headless-shell/i.test(path.basename(exe)) ? '--headless' : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(exe, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('Chrome 시작 시간 초과: ' + buf.slice(-400))), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); res(m[1]); buf = ''; }
    });
    proc.on('error', (e) => { clearTimeout(t); rej(e); });
    proc.on('exit', (c) => { clearTimeout(t); rej(new Error(`Chrome 종료(${c}): ${buf.slice(-400)}`)); });
  });
  return {
    proc,
    wsUrl,
    close() {
      if (proc.exitCode !== null) return Promise.resolve();
      return new Promise((res) => { proc.once('exit', res); proc.kill('SIGTERM'); });
    },
  };
}
