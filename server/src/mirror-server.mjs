import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CDP, openPage } from './cdp.mjs';
import { launchChrome } from './chrome.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const AGENT = readFileSync(here('./agent.js'), 'utf8');
const CLIENT_HTML = readFileSync(here('../client/index.html'));
const CLIENT_JS = readFileSync(here('../client/mirror.js'));

const KEYS = {
  Enter: 13, Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
};
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'upgrade']);

/**
 * 서버 Chrome에서 target(리수 주소)을 열고, 폰에는 DOM 변화만 보내는 미러 서버.
 * @param {{target:string, port?:number, host?:string, token?:string, chromeBin?:string, userDataDir?:string}} o
 */
export async function startMirror(o) {
  const target = new URL(o.target);
  const chrome = await launchChrome({ bin: o.chromeBin, userDataDir: o.userDataDir });
  const cdp = await CDP.connect(chrome.wsUrl);
  const page = await openPage(cdp);
  const clients = new Set();

  const broadcast = (payload) => {
    for (const res of clients) res.write(`data: ${payload}\n\n`);
  };
  page.on((m) => {
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__parlorEmit') broadcast(m.params.payload);
  });

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Runtime.addBinding', { name: '__parlorEmit' });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: AGENT, runImmediately: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Page.navigate', { url: target.href });

  const evaluate = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // 폰에서 온 입력은 받은 순서대로 하나씩 처리한다.
  let queue = Promise.resolve();
  const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error('[parlor]', e.message)));

  async function handleEvent(ev) {
    const i = Number(ev.i) | 0;
    if (ev.type === 'click') {
      const p = await evaluate(`__parlor.point(${i})`);
      if (!p) return evaluate(`__parlor.click(${i})`);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
      }
    } else if (ev.type === 'key') {
      const code = KEYS[ev.key];
      if (!code) return;
      if (i) await evaluate(`__parlor.focus(${i})`);
      const modifiers = (ev.alt ? 1 : 0) | (ev.ctrl ? 2 : 0) | (ev.meta ? 4 : 0) | (ev.shift ? 8 : 0);
      const base = { key: ev.key, code: ev.key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
      // rawKeyDown: 문자 입력 없이 키 처리기만 실행(값은 따로 동기화됨)
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    } else if (ev.type === 'input' || ev.type === 'change' || ev.type === 'scroll') {
      await evaluate(`__parlor.apply(${JSON.stringify({ type: ev.type, i, v: String(ev.v ?? ''), k: !!ev.k, x: +ev.x || 0, y: +ev.y || 0 })})`);
    }
  }

  const blobCache = new Map();
  async function getBlob(u) {
    if (blobCache.has(u)) return blobCache.get(u);
    const b = await evaluate(`__parlor.blob(${JSON.stringify(u)})`);
    const v = { type: b.t, body: Buffer.from(b.d, 'base64') };
    blobCache.set(u, v);
    if (blobCache.size > 300) blobCache.delete(blobCache.keys().next().value);
    return v;
  }

  const authed = (req, url, res) => {
    if (!o.token) return true;
    if (url.searchParams.get('token') === o.token) {
      res.setHeader('Set-Cookie', `parlor_token=${encodeURIComponent(o.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      return true;
    }
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)parlor_token=([^;]+)/);
    return !!m && decodeURIComponent(m[1]) === o.token;
  };

  const readJson = (req) => new Promise((res, rej) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 4e6) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch (e) { rej(e); } });
    req.on('error', rej);
  });

  async function proxy(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const r = await fetch(new URL(url.pathname + url.search, target), { method: req.method, redirect: 'manual' });
    const headers = {};
    r.headers.forEach((v, k) => { if (!HOP.has(k)) headers[k] = v; });
    res.writeHead(r.status, headers);
    if (r.body && req.method === 'GET') Readable.fromWeb(r.body).pipe(res);
    else res.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!authed(req, url, res)) { res.writeHead(401).end('token 필요'); return; }
      const p = url.pathname;
      if (p === '/' ) { res.writeHead(302, { Location: '/__parlor/' }).end(); return; }
      if (p === '/__parlor/' || p === '/__parlor') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(CLIENT_HTML);
      } else if (p === '/__parlor/mirror.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(CLIENT_JS);
      } else if (p === '/__parlor/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': hi\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clients.delete(res); clearInterval(ping); });
        enqueue(() => evaluate('window.__parlor && __parlor.snap()'));
      } else if (p === '/__parlor/event' && req.method === 'POST') {
        const ev = await readJson(req);
        await enqueue(() => handleEvent(ev));
        res.writeHead(204).end();
      } else if (p === '/__parlor/viewport' && req.method === 'POST') {
        const v = await readJson(req);
        const width = Math.min(Math.max(v.w | 0, 200), 3000);
        const height = Math.min(Math.max(v.h | 0, 200), 3000);
        await enqueue(() => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true }));
        res.writeHead(204).end();
      } else if (p === '/__parlor/blob') {
        const b = await enqueue(() => getBlob(url.searchParams.get('u') || ''));
        if (!b) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': b.type, 'cache-control': 'private, max-age=31536000, immutable' }).end(b.body);
      } else {
        await proxy(req, res, url);
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(502).end(String(e.message));
      else res.end();
    }
  });

  await new Promise((r) => server.listen(o.port ?? 7300, o.host ?? '0.0.0.0', r));

  return {
    port: server.address().port,
    page,
    evaluate,
    async close() {
      for (const res of clients) res.end();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      cdp.close();
      await chrome.close();
    },
  };
}
