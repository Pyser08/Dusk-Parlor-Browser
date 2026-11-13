import http from 'node:http';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, createWriteStream, createReadStream, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes, createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CDP, openPage, session } from './cdp.mjs';
import { launchChrome } from './chrome.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const AGENT = readFileSync(here('./agent.js'), 'utf8');
const CLIENT_HTML = readFileSync(here('../client/index.html'));
const CLIENT_JS = readFileSync(here('../client/mirror.js'));
const LOGIN_HTML = readFileSync(here('../client/login.html'));

const KEYS = {
  Enter: 13, Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
};
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'upgrade']);

/**
 * 서버 Chrome에서 target(리수 주소)을 열고, 폰에는 DOM 변화만 보내는 미러 서버.
 * @param {{target:string, port?:number, host?:string, chromeBin?:string, userDataDir?:string}} o
 */
export async function startMirror(o) {
  const target = new URL(o.target);
  const chrome = await launchChrome({ bin: o.chromeBin, userDataDir: o.userDataDir });
  const cdp = await CDP.connect(chrome.wsUrl);
  const page = await openPage(cdp);
  await page.send('Performance.enable').catch(() => {}); // 상태 페이지의 메모리·노드 수
  const clients = new Set();
  let current = null; // 지금 탭을 쓰는 폰 { sid, res }
  const bye = (c) => { clients.delete(c.res); c.res.end('event: bye\ndata: {}\n\n'); };

  // 서버 → 폰 메시지: { f: 프레임 키, ops: [...] }. 최상위 프레임 키는 'top'.
  const dbg = process.env.PARLOR_DEBUG ? (...a) => console.error('[dbg]', ...a) : () => {};
  // 상태(/__parlor/stats): 최근 1분 동안 폰으로 보낸 양과 종류, 최근 입력 처리 시간
  const stats = { sent: [], events: [] };
  const statSent = (bytes, kind) => {
    const now = Date.now();
    stats.sent.push([now, bytes, kind]);
    while (stats.sent.length && stats.sent[0][0] < now - 60000) stats.sent.shift();
  };
  const broadcast = (f, opsJson) => {
    dbg('보냄', f, opsJson.slice(0, 80));
    const line = `data: {"f":${JSON.stringify(f)},"ops":${opsJson}}\n\n`;
    statSent(line.length, opsJson.slice(0, 40).match(/"op":"(\w+)"/)?.[1] || '?');
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
      } else if (m.method === 'Page.fileChooserOpened') {
        onFileChooser(sess, m.params);
      } else if (m.method === 'Input.dragIntercepted') {
        drag.data = m.params.data;
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
    // 파일 창은 서버 화면에 뜨면 아무도 못 고르므로 가로채서 폰에서 고르게 한다.
    await sess.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
    // 플러그인 iframe은 별도 프로세스(OOPIF)라 자동 연결로 받는다. 에이전트를 심기 전까지 멈춰 둔다.
    await sess.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    if (parentSess) await sess.send('Runtime.runIfWaitingForDebugger');
  }

  // ── 파일 가져오기·내보내기 ──
  const work = mkdtempSync(path.join(os.tmpdir(), 'parlor-files-'));
  const downloadDir = path.join(work, 'down');
  const uploadDir = path.join(work, 'up');
  mkdirSync(downloadDir);
  mkdirSync(uploadDir);
  const choosers = new Map(); // id → { sess, backendNodeId, multiple, accept }
  let nextChooser = 1;
  async function onFileChooser(sess, p) {
    let accept = '';
    try {
      const { object } = await sess.send('DOM.resolveNode', { backendNodeId: p.backendNodeId });
      const r = await sess.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return this.accept || ""; }', returnByValue: true });
      accept = r.result.value || '';
    } catch {}
    const id = String(nextChooser++);
    choosers.set(id, { sess, backendNodeId: p.backendNodeId, multiple: p.mode === 'selectMultiple', accept });
    dbg('파일 창', id, p.mode, accept);
    // 플러그인 가져오기(.js)라면 폰에 'Dusk Atelier 최신판 넣기' 버튼도 준다
    const dusk = !!o.dusk && /\.js\b|javascript/i.test(accept);
    broadcast('top', JSON.stringify([{ op: 'file', id, multiple: p.mode === 'selectMultiple', accept, dusk }]));
  }

  // ── Dusk Atelier 안내·설치 (o.dusk = { url }) ──
  // 처음 접속한 폰에 안내를 한 번 띄우고, 플러그인 파일 창에서 버튼을 누르면 최신 릴리즈를 받아 넣는다.
  const stateFile = o.userDataDir ? path.join(o.userDataDir, 'parlor-state.json') : null;
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {}
  const saveState = () => { if (stateFile) try { writeFileSync(stateFile, JSON.stringify(state)); } catch {} };
  async function putDusk(id) {
    const c = choosers.get(id);
    if (!c || !o.dusk) return false;
    const r = await fetch(o.dusk.url, { redirect: 'follow' });
    if (!r.ok) throw new Error('Dusk Atelier를 받지 못했어요(' + r.status + ')');
    const dir = path.join(uploadDir, id, 'dusk');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'dusk_atelier.js');
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    choosers.delete(id);
    await enqueue(() => c.sess.send('DOM.setFileInputFiles', { files: [file], backendNodeId: c.backendNodeId }));
    state.duskHintDone = true;
    saveState();
    return true;
  }
  const downloads = new Map(); // guid → { name, done }
  cdp.on((m) => {
    if (m.sessionId) return;
    if (m.method === 'Browser.downloadWillBegin') {
      downloads.set(m.params.guid, { name: m.params.suggestedFilename || 'download', done: false });
    } else if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') {
      const d = downloads.get(m.params.guid);
      if (!d) return;
      d.done = true;
      dbg('다운로드', d.name);
      broadcast('top', JSON.stringify([{ op: 'download', id: m.params.guid, name: d.name }]));
    }
  });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true });

  // ── 새 창: 서버에서 열린 새 탭(window.open, target=_blank)은 닫고 폰에서 열 링크로 보낸다 ──
  const openedTabs = new Set();
  const phoneUrl = (u) => {
    try {
      const x = new URL(u);
      return x.origin === target.origin ? x.pathname + x.search + x.hash : x.href;
    } catch { return u; }
  };
  cdp.on((m) => {
    if (m.sessionId || (m.method !== 'Target.targetCreated' && m.method !== 'Target.targetInfoChanged')) return;
    const info = m.params.targetInfo;
    if (info.type !== 'page' || info.openerId !== page.targetId || openedTabs.has(info.targetId)) return;
    if (!info.url || info.url === 'about:blank') return; // 주소가 정해지면 다시 온다
    openedTabs.add(info.targetId);
    dbg('새 창', info.url);
    broadcast('top', JSON.stringify([{ op: 'open', url: phoneUrl(info.url) }]));
    cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  // ── 드래그(네이티브 드래그 앤 드롭은 가로채서 드래그 이벤트로 이어 간다) ──
  const drag = { data: null, x: 0, y: 0 };

  await setupSession(page, null);
  await page.send('Input.setInterceptDrags', { enabled: true }).catch(() => {});
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
      const fx = Number.isFinite(+ev.fx) ? +ev.fx : 'undefined';
      const fy = Number.isFinite(+ev.fy) ? +ev.fy : 'undefined';
      const local = await evaluate(`__parlor.point(${i}, ${fx}, ${fy})`, key);
      if (local?.covered) return;
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
    } else if (ev.type === 'hover') {
      const fx = Number.isFinite(+ev.fx) ? +ev.fx : 'undefined';
      const fy = Number.isFinite(+ev.fy) ? +ev.fy : 'undefined';
      const local = await evaluate(`__parlor.point(${i}, ${fx}, ${fy}, true)`, key);
      if (!local || local.covered) return;
      const p = await toTop(key, local);
      if (p) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    } else if (ev.type === 'edit') {
      await evaluate(`__parlor.edit(${i}, ${JSON.stringify(String(ev.v ?? ''))})`, key);
    } else if (ev.type === 'context') {
      dbg('우클릭', key, i, ev.fx, ev.fy);
      const fx = Number.isFinite(+ev.fx) ? +ev.fx : 'undefined';
      const fy = Number.isFinite(+ev.fy) ? +ev.fy : 'undefined';
      const local = await evaluate(`__parlor.point(${i}, ${fx}, ${fy})`, key);
      if (local?.covered) return;
      const p = local && await toTop(key, local);
      if (!p) return evaluate(`__parlor.context(${i})`, key);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', buttons: 0, clickCount: 1 });
    } else if (ev.type === 'drag') {
      const p = await toTop(key, { x: +ev.x || 0, y: +ev.y || 0 });
      if (!p) return;
      const send = (type, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', ...extra });
      const dragEvent = (type) => page.send('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data: drag.data });
      if (ev.phase === 'start') {
        drag.data = null;
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
        await send('mousePressed', { buttons: 1, clickCount: 1 });
      } else if (ev.phase === 'move') {
        if (drag.data) await dragEvent('dragOver');
        else {
          await send('mouseMoved', { buttons: 1 });
          // 움직임으로 네이티브 드래그가 시작되면 dragIntercepted가 온다 → 바로 dragEnter
          await new Promise((r) => setTimeout(r, 20));
          if (drag.data) await dragEvent('dragEnter');
        }
      } else if (ev.phase === 'end') {
        if (drag.data) {
          await dragEvent('dragOver');
          await dragEvent('drop');
          drag.data = null;
        }
        await send('mouseReleased', { buttons: 0, clickCount: 1 });
      }
    } else if (ev.type === 'input' || ev.type === 'change' || ev.type === 'scroll') {
      await evaluate(`__parlor.apply(${JSON.stringify({ type: ev.type, i, v: String(ev.v ?? ''), k: !!ev.k, x: +ev.x || 0, y: +ev.y || 0 })})`, key);
    }
  }

  const blobCache = new Map();
  // blob 그림 가져오기: 한 번에 2개까지, 같은 그림은 한 번만
  const blobInflight = new Map();
  let blobActive = 0;
  const blobWait = [];
  async function blobLimited(u) {
    if (blobCache.has(u)) return blobCache.get(u);
    if (blobInflight.has(u)) return blobInflight.get(u);
    const p = (async () => {
      if (blobActive >= 2) await new Promise((r) => blobWait.push(r));
      blobActive++;
      try { return await getBlob(u); } finally { blobActive--; blobWait.shift()?.(); blobInflight.delete(u); }
    })();
    blobInflight.set(u, p);
    return p;
  }
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

  const readJson = (req) => new Promise((res, rej) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 4e6) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch (e) { rej(e); } });
    req.on('error', rej);
  });

  // ── 미러 로그인: 리수 비밀번호를 리수 서버(/api/login)에 물어 확인하고, 맞으면 이 기기를 기억한다 ──
  // 서버 Chrome은 리수에 로그인된 채 남으므로, 미러에 들어오는 사람은 따로 확인해야 한다.
  const sessionFile = o.sessionFile ?? (o.userDataDir ? path.join(o.userDataDir, 'parlor-sessions.json') : null);
  const sessions = new Set();
  try { for (const t of JSON.parse(readFileSync(sessionFile, 'utf8'))) sessions.add(t); } catch {}
  const saveSessions = () => { if (sessionFile) try { writeFileSync(sessionFile, JSON.stringify([...sessions])); } catch {} };
  const sessionOf = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)parlor_session=([A-Za-z0-9_-]+)/)?.[1];
  const loggedIn = (req) => sessions.has(sessionOf(req));
  let lastFail = 0;
  async function checkPassword(typed) {
    // 반환: 'ok' | 'wrong' | 'error'. 리수에 비밀번호가 없으면(Password not set) 확인 없이 통과.
    // 리수 화면은 친 비밀번호를 그대로 보내지 않고 리수 서버의 /api/crypto로 해시(SHA-256 hex)한 값을 보낸다 → 똑같이 한다.
    // /api/crypto가 없는 호스트면 여기서 SHA-256을 계산한다.
    let password = '';
    const h = await fetch(new URL('/api/crypto', target), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: typed }) }).catch(() => null);
    if (h && h.ok) password = (await h.text()).trim();
    if (!/^[0-9a-f]{64}$/i.test(password)) password = createHash('sha256').update(typed, 'utf8').digest('hex');
    const r = await fetch(new URL('/api/login', target), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }).catch(() => null);
    if (!r) return 'error';
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.status === 'success') return 'ok';
    if (/not set/i.test(j.error || '')) return 'ok';
    if (r.status === 400 || r.status === 401 || r.status === 403) return 'wrong';
    return 'error';
  }

  // ── /__parlor/ 밖의 요청은 리수로 그대로 넘긴다(PC에서 리수를 바로 쓰는 길) ──
  // 미러에 로그인한 기기에만 서버 Chrome의 쿠키(리스바드 HttpOnly 세션 등)를 붙인다. 미러 화면의 그림·CSS가 이 길로 온다.
  const HOP_REQ = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'proxy-connection']);
  async function proxy(req, res) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_REQ.has(k)) headers[k] = v;
    headers.host = target.host;
    if (loggedIn(req)) {
      const { cookies } = await page.send('Network.getCookies', { urls: [new URL(req.url, target).href] });
      const own = String(headers.cookie || '').split(/;\s*/).filter((c) => c && !c.startsWith('parlor_session='));
      headers.cookie = [...own, ...cookies.map((c) => `${c.name}=${c.value}`)].join('; ');
    }
    if (!headers.cookie) delete headers.cookie;
    const mod = target.protocol === 'https:' ? await import('node:https') : http;
    await new Promise((done) => {
      const up = mod.request({ host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), method: req.method, path: req.url, headers }, (r) => {
        const out = {};
        for (const [k, v] of Object.entries(r.headers)) if (k !== 'connection' && k !== 'keep-alive' && k !== 'transfer-encoding') out[k] = v;
        res.writeHead(r.statusCode, out);
        r.pipe(res);
        r.on('end', done);
        r.on('error', done);
      });
      up.on('error', (e) => { if (!res.headersSent) res.writeHead(502).end(String(e.message)); else res.end(); done(); });
      req.pipe(up);
    });
  }
  // 웹소켓 등 Upgrade 요청은 TCP를 그대로 이어 준다
  function tunnel(req, sock, head) {
    if (req.url.startsWith('/__parlor')) { sock.destroy(); return; }
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const up = target.protocol === 'https:' ? tls.connect(port, target.hostname, { servername: target.hostname }) : net.connect(port, target.hostname);
    up.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    const end = () => { up.destroy(); sock.destroy(); };
    up.on('error', end); sock.on('error', end);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const p = url.pathname;
      if (!p.startsWith('/__parlor')) { await proxy(req, res); return; }
      if (p === '/__parlor/login' && req.method === 'POST') {
        const d = await readJson(req).catch(() => ({}));
        // 마구 대입 막기: 틀린 뒤 1초 동안은 다시 확인하지 않음
        if (Date.now() - lastFail < 1000) { res.writeHead(429).end(); return; }
        const v = await checkPassword(String(d.password ?? ''));
        if (v !== 'ok') { if (v === 'wrong') lastFail = Date.now(); res.writeHead(v === 'wrong' ? 401 : 502).end(); return; }
        const t = randomBytes(24).toString('base64url');
        sessions.add(t);
        saveSessions();
        res.writeHead(204, { 'Set-Cookie': `parlor_session=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` }).end();
        return;
      }
      if (!loggedIn(req)) {
        if (req.method === 'GET' && (p === '/__parlor/' || p === '/__parlor')) res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(LOGIN_HTML);
        else res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('로그인이 필요해요');
        return;
      }
      if (p === '/__parlor/' || p === '/__parlor') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(CLIENT_HTML);
      } else if (p === '/__parlor/mirror.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(CLIENT_JS);
      } else if (p === '/__parlor/stream') {
        // nginx 등 앞단 서버 뒤에 있어도 바로바로 가도록: 버퍼링 끄기(X-Accel-Buffering)·압축 안 함(no-transform).
        // 앞단 서버가 없으면 그냥 무시되는 헤더라 늘 붙인다.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        // 탭 하나를 한 번에 한 폰만 쓴다. 새로 연 폰(sid 없음)이 이전 폰을 끊고, 끊긴 폰이 자동 재연결(sid 있음)로
        // 다시 빼앗지는 않는다. 끊긴 폰은 '여기서 다시 열기'로 새로 열어야 되찾는다.
        const old = url.searchParams.get('sid');
        if (old && current && current.sid !== old) { res.end('event: bye\ndata: {}\n\n'); return; }
        if (current && current.sid !== old) bye(current);
        const me = { sid: old || randomBytes(9).toString('base64url'), res };
        current = me;
        res.write(`event: hello\ndata: ${JSON.stringify({ sid: me.sid })}\n\n`);
        if (o.dusk && !state.duskHintDone) res.write(`data: ${JSON.stringify({ f: 'top', ops: [{ op: 'duskhint' }] })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clients.delete(res); clearInterval(ping); if (current === me) current = null; });
        enqueue(snapAll);
      } else if (req.method === 'POST' && p.startsWith('/__parlor/') && (!current || req.headers['x-parlor-sid'] !== current.sid)) {
        // 끊긴 폰(또는 아직 연결 전)의 입력은 받지 않는다
        res.writeHead(409).end();
      } else if (p === '/__parlor/event' && req.method === 'POST') {
        const ev = await readJson(req);
        const t0 = Date.now();
        let t1 = 0;
        await enqueue(() => { t1 = Date.now(); return handleEvent(ev); });
        stats.events.push({ type: ev.type, wait: t1 - t0, run: Date.now() - t1, at: new Date(t0).toISOString().slice(11, 19) });
        if (stats.events.length > 20) stats.events.shift();
        res.writeHead(204).end();
      } else if (p === '/__parlor/clip' && req.method === 'POST') {
        const d = await readJson(req);
        const key = typeof d.f === 'string' && frames.has(d.f) ? d.f : 'top';
        await enqueue(() => evaluate(`__parlor.clipAnswer(${Number(d.id) | 0}, ${d.text == null ? 'null' : JSON.stringify(String(d.text))})`, key));
        res.writeHead(204).end();
      } else if (p === '/__parlor/upload' && req.method === 'POST') {
        // 폰에서 고른 파일 하나를 받아 서버 임시 폴더에 원래 이름 그대로 저장
        const id = String(url.searchParams.get('id'));
        const n = Number(url.searchParams.get('i')) | 0;
        const name = path.basename(String(url.searchParams.get('name') || 'file')).replace(/[\x00-\x1f]/g, '') || 'file';
        if (!choosers.has(id)) { res.writeHead(404).end(); return; }
        const dir = path.join(uploadDir, id, String(n));
        mkdirSync(dir, { recursive: true });
        await pipeline(req, createWriteStream(path.join(dir, name)));
        res.writeHead(204).end();
      } else if (p === '/__parlor/dusk' && req.method === 'POST') {
        const d = await readJson(req);
        try { res.writeHead((await putDusk(String(d.id))) ? 204 : 404).end(); } catch (e) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e.message)); }
      } else if (p === '/__parlor/dusk-hint-done' && req.method === 'POST') {
        state.duskHintDone = true;
        saveState();
        res.writeHead(204).end();
      } else if (p === '/__parlor/upload-done' && req.method === 'POST') {
        const d = await readJson(req);
        const c = choosers.get(String(d.id));
        choosers.delete(String(d.id));
        if (c && !d.cancel) {
          const files = [];
          for (let n = 0; n < (Number(d.n) | 0); n++) {
            const dir = path.join(uploadDir, String(d.id), String(n));
            for (const f of readdirSync(dir)) files.push(path.join(dir, f));
          }
          await enqueue(() => c.sess.send('DOM.setFileInputFiles', { files: c.multiple ? files : files.slice(0, 1), backendNodeId: c.backendNodeId }));
        }
        res.writeHead(204).end();
      } else if (p.startsWith('/__parlor/download/')) {
        const guid = decodeURIComponent(p.slice('/__parlor/download/'.length));
        const d = downloads.get(guid);
        const file = path.join(downloadDir, path.basename(guid));
        if (!d || !d.done) { res.writeHead(404).end(); return; }
        const ascii = d.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': statSync(file).size,
          'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
          'cache-control': 'no-store',
        });
        createReadStream(file).pipe(res);
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
      } else if (p === '/__parlor/stats') {
        const byKind = {};
        let total = 0;
        for (const [, b, k] of stats.sent) { total += b; byKind[k] = (byKind[k] || 0) + b; }
        const m = await page.send('Performance.getMetrics').then((r) => Object.fromEntries(r.metrics.map((x) => [x.name, x.value])), () => ({}));
        const kb = (n) => Math.round(n / 1024) + 'KB';
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify({
          '최근 1분 폰으로 보낸 양': kb(total),
          '종류별': Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, kb(v)])),
          '최근 입력(기다림·처리 ms)': stats.events.slice().reverse(),
          '서버 리수 JS 메모리': m.JSHeapUsedSize ? Math.round(m.JSHeapUsedSize / 1048576) + 'MB' : '?',
          '서버 리수 DOM 노드 수': m.Nodes ?? '?',
          '연결된 폰': clients.size,
        }, null, 2));
      } else if (p === '/__parlor/blob') {
        // 읽기만 하므로 누르기 줄(enqueue)과 따로 처리한다. 그림이 많아도 누르기가 밀리지 않게.
        const b = await blobLimited(url.searchParams.get('u') || '');
        if (!b) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': b.type, 'cache-control': 'private, max-age=31536000, immutable' }).end(b.body);
      } else {
        res.writeHead(404).end();
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(502).end(String(e.message));
      else res.end();
    }
  });

  server.on('upgrade', tunnel);
  await new Promise((r) => server.listen(o.port ?? 7300, o.host ?? '0.0.0.0', r));

  return {
    port: server.address().port,
    page,
    get sid() { return current?.sid ?? ''; }, // 지금 탭을 쓰는 폰(시험용)
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
