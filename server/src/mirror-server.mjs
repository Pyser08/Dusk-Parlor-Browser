import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CDP, openPage, session } from './cdp.mjs';
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

  // 서버 → 폰 메시지: { f: 프레임 키, ops: [...] }. 최상위 프레임 키는 'top'.
  const dbg = process.env.PARLOR_DEBUG ? (...a) => console.error('[dbg]', ...a) : () => {};
  const broadcast = (f, opsJson) => {
    dbg('보냄', f, opsJson.slice(0, 80));
    const line = `data: {"f":${JSON.stringify(f)},"ops":${opsJson}}\n\n`;
    for (const res of clients) res.write(line);
  };

  // ── 프레임 표 (DESIGN-frames.md) ──
  // key → { key, frameId, sess(세션 핸들), contextId, parentSess, owner(부모 문서의 iframe 노드 id), parentKey }
  const frames = new Map();
  const keyByFrameId = new Map();
  const keyByContext = new Map(); // `${sessionId}:${contextId}` → key
  const early = new Map(); // 맥락 등록 전에 온 메시지
  let nextFrame = 1;
  let topFrameId = null;

  const frameKeyFor = (frameId) => {
    if (frameId === topFrameId) return 'top';
    let k = keyByFrameId.get(frameId);
    if (!k) { k = 'f' + nextFrame++; keyByFrameId.set(frameId, k); }
    return k;
  };

  async function evalIn(rec, expression) {
    const params = { expression, returnByValue: true, awaitPromise: true };
    if (rec.contextId) params.contextId = rec.contextId;
    const r = await rec.sess.send('Runtime.evaluate', params);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  const evaluate = (expression, key = 'top') => {
    const rec = frames.get(key);
    if (!rec) return Promise.reject(new Error('프레임 없음: ' + key));
    return evalIn(rec, expression);
  };

  // iframe 요소(부모 문서)와 프레임을 짝지어 폰에 알린다.
  async function linkOwner(rec) {
    try {
      const { backendNodeId } = await rec.parentSess.send('DOM.getFrameOwner', { frameId: rec.frameId });
      const { object } = await rec.parentSess.send('DOM.resolveNode', { backendNodeId });
      const r = await rec.parentSess.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        // 이 함수는 iframe 요소가 속한(부모) 문서에서 실행된다.
        functionDeclaration: 'function () { return window.__parlor ? [__parlor.idOf(this), window.__parlorKey || "top"] : [0, "top"]; }',
        returnByValue: true,
      });
      dbg('linkOwner', rec.key, JSON.stringify(r.result.value ?? r.exceptionDetails?.text));
      [rec.owner, rec.parentKey] = r.result.value || [0, 'top'];
      if (rec.owner) broadcast(rec.parentKey, JSON.stringify([{ op: 'frame', owner: rec.owner, key: rec.key }]));
    } catch (e) {
      dbg('linkOwner 실패', rec.key, e.message);
      // 이미 사라진 프레임 등
    }
  }

  function onContext(sess, parentSess, m) {
    const c = m.params.context;
    const frameId = c.auxData?.frameId;
    if (!frameId || !c.auxData?.isDefault) return;
    const key = frameKeyFor(frameId);
    dbg('맥락', key, frameId.slice(0, 8), c.id, sess.id?.slice(0, 8));
    const ck = `${sess.id}:${c.id}`;
    keyByContext.set(ck, key);
    const q = early.get(ck);
    if (q) { early.delete(ck); for (const payload of q) broadcast(key, payload); }
    let rec = frames.get(key);
    if (!rec) {
      rec = { key, frameId, sess, parentSess: key === 'top' ? null : parentSess, owner: 0, parentKey: null };
      frames.set(key, rec);
    }
    rec.sess = sess;
    rec.contextId = c.id;
    // 자식 iframe의 부모가 어느 프레임인지 알아낼 수 있도록 문서에 자기 키를 적어 둔다.
    sess.send('Runtime.evaluate', { expression: `window.__parlorKey = ${JSON.stringify(key)}`, contextId: c.id }).catch(() => {});
    if (key !== 'top') linkOwner(rec);
  }

  function dropFrame(frameId) {
    const key = keyByFrameId.get(frameId);
    if (!key) return;
    frames.delete(key);
    keyByFrameId.delete(frameId);
    for (const [ck, k] of keyByContext) if (k === key) keyByContext.delete(ck);
  }

  // 대화상자(alert/confirm/prompt). 폰이 답할 때까지 열어 두고, 폰이 없으면 바로 닫는다.
  let dialog = null; // { sess, type }
  function onDialog(sess, p) {
    dbg('대화상자', sess.id?.slice(0, 8), p.type, p.message, '폰', clients.size);
    if (p.type === 'beforeunload' || !clients.size) {
      sess.send('Page.handleJavaScriptDialog', { accept: p.type !== 'confirm' }).catch(() => {});
      return;
    }
    dialog = { sess, type: p.type };
    broadcast('top', JSON.stringify([{ op: 'dialog', type: p.type, message: p.message, value: p.defaultPrompt || '' }]));
  }

  // 한 세션(최상위 탭 또는 OOPIF)을 미러용으로 준비한다.
  async function setupSession(sess, parentSess) {
    sess.on((m) => {
      if (m.method === 'Runtime.bindingCalled' && m.params.name === '__parlorEmit') {
        const ck = `${sess.id}:${m.params.executionContextId}`;
        const key = keyByContext.get(ck);
        if (key) broadcast(key, m.params.payload);
        else {
          // 실행 맥락 등록보다 먼저 온 메시지는 등록될 때까지 보관한다.
          let q = early.get(ck);
          if (!q) early.set(ck, (q = []));
          q.push(m.params.payload);
        }
      } else if (m.method === 'Runtime.executionContextCreated') {
        onContext(sess, parentSess || sess, m);
      } else if (m.method === 'Page.frameDetached' && m.params.reason !== 'swap') {
        dropFrame(m.params.frameId);
      } else if (m.method === 'Page.javascriptDialogOpening') {
        onDialog(sess, m.params);
      } else if (m.method === 'Target.attachedToTarget') {
        const info = m.params.targetInfo;
        dbg('연결', info.type, info.url, info.targetId.slice(0, 8));
        const child = session(cdp, m.params.sessionId);
        if (info.type === 'iframe') {
          setupSession(child, sess).catch((e) => console.error('[parlor] 프레임 연결 실패', e.message));
        } else {
          // 워커 등은 미러 대상이 아님: 멈춘 채로 두지 않도록 실행만 시키고 뗀다.
          child.send('Runtime.runIfWaitingForDebugger').catch(() => {});
          sess.send('Target.detachFromTarget', { sessionId: m.params.sessionId }).catch(() => {});
        }
      } else if (m.method === 'Target.detachedFromTarget') {
        if (m.params.targetId) dropFrame(m.params.targetId);
      }
    });
    await sess.send('Page.enable');
    if (!parentSess) topFrameId = (await sess.send('Page.getFrameTree')).frameTree.frame.id;
    await sess.send('Runtime.enable');
    await sess.send('Runtime.addBinding', { name: '__parlorEmit' });
    await sess.send('Page.addScriptToEvaluateOnNewDocument', { source: AGENT, runImmediately: true });
    // 플러그인 iframe은 별도 프로세스(OOPIF)라 자동 연결로 받는다. 에이전트를 심기 전까지 멈춰 둔다.
    await sess.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    if (parentSess) await sess.send('Runtime.runIfWaitingForDebugger');
  }

  await setupSession(page, null);
  frames.set('top', frames.get('top') || { key: 'top', frameId: topFrameId, sess: page, owner: 0 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Page.navigate', { url: target.href });

  // 폰이 붙으면 최상위 → 각 프레임 순서로 전체 화면을 다시 보낸다.
  async function snapAll() {
    await evaluate('window.__parlor && __parlor.snap()').catch(() => {});
    for (const rec of [...frames.values()]) {
      if (rec.key === 'top') continue;
      if (rec.owner) broadcast(rec.parentKey || 'top', JSON.stringify([{ op: 'frame', owner: rec.owner, key: rec.key }]));
      await evalIn(rec, 'window.__parlor && __parlor.snap()').catch(() => {});
    }
  }

  // 프레임 안 좌표 → 최상위 화면 좌표
  async function toTop(key, p) {
    let rec = frames.get(key);
    while (rec && rec.key !== 'top') {
      const parent = frames.get(rec.parentKey || 'top');
      if (!parent || !rec.owner) return null;
      const off = await evalIn(parent, `__parlor.frameOffset(${rec.owner})`);
      if (!off) return null;
      p = { x: p.x + off.x, y: p.y + off.y };
      rec = parent;
    }
    return p;
  }

  // 폰에서 온 입력은 받은 순서대로 하나씩 처리한다.
  let queue = Promise.resolve();
  const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error('[parlor]', e.message)));

  async function handleEvent(ev) {
    const i = Number(ev.i) | 0;
    const key = typeof ev.f === 'string' && frames.has(ev.f) ? ev.f : 'top';
    if (ev.type === 'click') {
      const local = await evaluate(`__parlor.point(${i})`, key);
      const p = local && await toTop(key, local);
      dbg('클릭', key, i, JSON.stringify(local), JSON.stringify(p));
      if (!p) return evaluate(`__parlor.click(${i})`, key);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      for (const type of ['mousePressed', 'mouseReleased']) {
        // 클릭이 대화상자를 띄우면 응답이 대화상자가 닫힐 때까지 안 오므로 기다리지 않는다.
        const sent = page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
        if (type === 'mousePressed') await sent;
        else await Promise.race([sent, new Promise((r) => setTimeout(r, 300))]);
      }
    } else if (ev.type === 'key') {
      const code = KEYS[ev.key];
      if (!code) return;
      if (key !== 'top') {
        return evaluate(`__parlor.key(${i}, ${JSON.stringify({ key: ev.key, shift: !!ev.shift, ctrl: !!ev.ctrl, alt: !!ev.alt, meta: !!ev.meta })})`, key);
      }
      if (i) await evaluate(`__parlor.focus(${i})`, key);
      const modifiers = (ev.alt ? 1 : 0) | (ev.ctrl ? 2 : 0) | (ev.meta ? 4 : 0) | (ev.shift ? 8 : 0);
      const base = { key: ev.key, code: ev.key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
      // rawKeyDown: 문자 입력 없이 키 처리기만 실행(값은 따로 동기화됨)
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    } else if (ev.type === 'input' || ev.type === 'change' || ev.type === 'scroll') {
      await evaluate(`__parlor.apply(${JSON.stringify({ type: ev.type, i, v: String(ev.v ?? ''), k: !!ev.k, x: +ev.x || 0, y: +ev.y || 0 })})`, key);
    }
  }

  const blobCache = new Map();
  async function getBlob(u) {
    if (blobCache.has(u)) return blobCache.get(u);
    // blob: 주소는 만든 프레임에서만 읽힌다(샌드박스 프레임은 origin이 null). 최상위부터 차례로 시도.
    let b = null;
    for (const rec of [...frames.values()]) {
      b = await evalIn(rec, `__parlor.blob(${JSON.stringify(u)})`).catch(() => null);
      if (b) break;
    }
    if (!b) return null;
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
    const dest = new URL(url.pathname + url.search, target);
    // 리스바드 등은 HttpOnly 세션 쿠키로 파일을 지키므로 서버 Chrome의 쿠키를 그대로 붙인다.
    const { cookies } = await page.send('Network.getCookies', { urls: [dest.href] });
    const reqHeaders = cookies.length ? { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') } : {};
    const r = await fetch(dest, { method: req.method, redirect: 'manual', headers: reqHeaders });
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
        enqueue(snapAll);
      } else if (p === '/__parlor/event' && req.method === 'POST') {
        const ev = await readJson(req);
        await enqueue(() => handleEvent(ev));
        res.writeHead(204).end();
      } else if (p === '/__parlor/dialog' && req.method === 'POST') {
        // 대화상자가 열려 있는 동안 입력 줄이 막혀 있으므로 줄을 거치지 않고 바로 답한다.
        const d = await readJson(req);
        const cur = dialog;
        dbg('대화상자 답', JSON.stringify(d), !!cur);
        dialog = null;
        if (cur) await cur.sess.send('Page.handleJavaScriptDialog', { accept: !!d.accept, promptText: String(d.text ?? '') }).catch(() => {});
        res.writeHead(204).end();
      } else if (p === '/__parlor/resnap' && req.method === 'POST') {
        // 폰의 iframe이 다시 로드돼 내용이 날아갔을 때
        const d = await readJson(req);
        const rec = frames.get(String(d.f));
        if (rec) enqueue(() => evalIn(rec, 'window.__parlor && __parlor.snap()'));
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
    evaluate: (expr) => evaluate(expr),
    async close() {
      for (const res of clients) res.end();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      cdp.close();
      await chrome.close();
    },
  };
}
