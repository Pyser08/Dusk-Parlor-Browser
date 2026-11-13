// 서버 Chrome의 리수 페이지 안에 주입되는 스크립트.
// DOM을 직렬화하고, 바뀐 부분만 __parlorEmit 바인딩으로 내보낸다.
(() => {
  // 모든 프레임(플러그인 iframe 포함)에서 실행된다. 어느 프레임의 메시지인지는
  // 서버가 바인딩 호출의 실행 맥락으로 구분해 붙인다(DESIGN-frames.md).
  if (window.__parlor) return;
  const emit = (ops) => { if (ops.length) try { window.__parlorEmit(JSON.stringify(ops)); } catch {} };

  const ids = new WeakMap();
  const byId = new Map();
  const skipped = new WeakSet();
  let nextId = 1;
  let sent = new Set(); // 클라이언트가 이미 가진 노드 id

  const idOf = (n) => {
    let i = ids.get(n);
    if (!i) { i = nextId++; ids.set(n, i); byId.set(i, new WeakRef(n)); }
    return i;
  };
  const node = (i) => byId.get(i)?.deref() || null;
  const known = (n) => { const i = ids.get(n); return i && sent.has(i) ? i : 0; };

  // blob: 주소는 폰에서 열 수 없으니 서버 경유 주소로 바꾼다.
  const fix = (v) => (v.indexOf('blob:') < 0 ? v
    : v.replace(/blob:[^\s"'()<>]+/g, (u) => '/__parlor/blob?u=' + encodeURIComponent(u)));
  const isField = (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT';
  const SKIP_LINK = /modulepreload|preload|prefetch|manifest/i;
  const keep = (n) => n.nodeType === 1 || n.nodeType === 3 || n.nodeType === 8;
  // iframe 내용은 프레임별로 따로 미러하므로 원본 문서 주소(src/srcdoc)는 보내지 않는다.
  const FRAME_ATTR = /^(src|srcdoc)$/i;
  const dropAttr = (n, name) => /^on/i.test(name) || (n.tagName === 'IFRAME' && FRAME_ATTR.test(name));

  function ser(n) {
    const i = idOf(n);
    sent.add(i);
    if (n.nodeType === 3) {
      return { i, t: 3, v: n.parentNode?.nodeName === 'STYLE' ? fix(n.data) : n.data };
    }
    if (n.nodeType !== 1) return { i, t: 8 };
    const tag = n.tagName;
    // 스크립트는 폰으로 보내지 않는다(실행은 서버에서만).
    if (tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'BASE' ||
        (tag === 'LINK' && SKIP_LINK.test(n.getAttribute('rel') || ''))) {
      skipped.add(n);
      return { i, t: 8 };
    }
    const a = [];
    for (const at of n.attributes) if (!dropAttr(n, at.name)) a.push([at.name, fix(at.value)]);
    const o = { i, t: 1, n: n.localName, a, c: [] };
    if (n.namespaceURI !== 'http://www.w3.org/1999/xhtml') o.ns = n.namespaceURI;
    if (isField(n)) {
      o.v = n.value;
      if (n.type === 'checkbox' || n.type === 'radio') o.k = n.checked;
    }
    for (const c of n.childNodes) if (keep(c)) o.c.push(ser(c));
    return o;
  }

  function unsend(n) {
    const i = ids.get(n);
    if (i) sent.delete(i);
    for (const c of n.childNodes) unsend(c);
  }

  const mo = new MutationObserver((recs) => {
    const ops = [];
    const dirty = new Set();
    const removed = new Set();
    for (const r of recs) {
      const t = r.target;
      if (r.type === 'childList') {
        if (known(t) && !skipped.has(t)) dirty.add(t);
        for (const n of r.removedNodes) removed.add(n);
        continue;
      }
      const ti = known(t);
      if (!ti) continue;
      if (r.type === 'attributes') {
        if (dropAttr(t, r.attributeName) || skipped.has(t)) continue;
        const v = t.getAttribute(r.attributeName);
        ops.push({ op: 'attr', i: ti, k: r.attributeName, v: v == null ? null : fix(v) });
      } else if (r.type === 'characterData') {
        if (t.parentNode && skipped.has(t.parentNode)) continue;
        ops.push({ op: 'text', i: ti, v: t.parentNode?.nodeName === 'STYLE' ? fix(t.data) : t.data });
      }
    }
    for (const p of dirty) {
      if (!p.isConnected) continue;
      const c = [];
      for (const ch of p.childNodes) {
        if (!keep(ch)) continue;
        const ci = known(ch);
        c.push(ci ? { r: ci } : ser(ch));
      }
      ops.push({ op: 'kids', p: ids.get(p), c });
    }
    for (const n of removed) if (!n.isConnected) unsend(n);
    emit(ops);
  });

  // 복사: 서버 Chrome의 클립보드가 아니라 폰 클립보드로 보낸다.
  const emitClip = (t) => { if (t) emit([{ op: 'clip', text: String(t) }]); };
  if (window.Clipboard) {
    const cw = Clipboard.prototype.writeText;
    const cwr = Clipboard.prototype.write;
    Clipboard.prototype.writeText = function (t) { emitClip(t); return cw.call(this, t).catch(() => {}); };
    Clipboard.prototype.write = function (items) {
      for (const it of items || []) {
        if (it.types?.includes('text/plain')) it.getType('text/plain').then((b) => b.text()).then(emitClip, () => {});
      }
      return cwr.call(this, items).catch(() => {});
    };
  }
  const exec = Document.prototype.execCommand;
  Document.prototype.execCommand = function (cmd, ...rest) {
    if (String(cmd).toLowerCase() === 'copy') {
      const a = this.activeElement;
      emitClip(a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')
        ? a.value.slice(a.selectionStart ?? 0, a.selectionEnd ?? 0) : String(this.getSelection?.() || ''));
    }
    return exec.call(this, cmd, ...rest);
  };
  // Chrome 전용 파일 API는 서버 화면에서만 열리므로 막아서, 리수가 input[type=file]·다운로드 링크를 쓰게 한다.
  for (const k of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    try { delete Window.prototype[k]; delete window[k]; } catch {}
  }

  // 입력값: 이벤트와 프로그램에서 바꾼 값(전송 후 비우기 등)을 모두 잡는다.
  const pendingVals = new Map();
  let valQueued = false;
  const flushVals = () => {
    valQueued = false;
    const ops = [];
    for (const [i, n] of pendingVals) ops.push({ op: 'val', i, v: n.value, k: !!n.checked });
    pendingVals.clear();
    emit(ops);
  };
  const queueVal = (n) => {
    const i = known(n);
    if (!i) return;
    pendingVals.set(i, n);
    if (!valQueued) { valQueued = true; queueMicrotask(flushVals); }
  };
  for (const C of [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement]) {
    for (const prop of ['value', 'checked', 'selectedIndex']) {
      const d = Object.getOwnPropertyDescriptor(C.prototype, prop);
      if (!d || !d.set) continue;
      Object.defineProperty(C.prototype, prop, {
        ...d,
        set(v) { d.set.call(this, v); queueVal(this); },
      });
    }
  }
  const onVal = (e) => { if (e.target instanceof Element && isField(e.target)) queueVal(e.target); };
  document.addEventListener('input', onVal, true);
  document.addEventListener('change', onVal, true);

  // 스크롤(리수의 자동 맨아래 스크롤 등)
  const scrolls = new Map();
  let scrollQueued = false;
  document.addEventListener('scroll', (e) => {
    const t = e.target === document ? document.scrollingElement : e.target;
    const i = t && known(t);
    if (!i) return;
    scrolls.set(i, t);
    if (scrollQueued) return;
    scrollQueued = true;
    setTimeout(() => {
      scrollQueued = false;
      const ops = [];
      for (const [i, t] of scrolls) ops.push({ op: 'scroll', i, x: t.scrollLeft, y: t.scrollTop });
      scrolls.clear();
      emit(ops);
    }, 30);
  }, true);

  function snap() {
    sent = new Set();
    const root = document.documentElement;
    if (!root) return;
    const ops = [{ op: 'snap', root: ser(root), title: document.title }];
    const se = document.scrollingElement;
    if (se && known(se)) ops.push({ op: 'scroll', i: known(se), x: se.scrollLeft, y: se.scrollTop });
    emit(ops);
  }

  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  // 폰의 터치는 아이콘 안쪽 SVG 조각(폭 0인 선 등)을 눌린 요소로 잡는다. 그런 조각은 크기가 없어
  // 누를 좌표를 못 구하므로 아이콘 전체(<svg>)를 기준으로 삼는다.
  const tapTarget = (n) => {
    if (n && n.nodeType !== 1) n = n.parentElement;
    if (n instanceof SVGElement && n.ownerSVGElement) {
      let svg = n.ownerSVGElement;
      while (svg.ownerSVGElement) svg = svg.ownerSVGElement;
      n = svg;
    }
    return n;
  };

  window.__parlor = {
    snap,
    node,
    // 서버가 iframe 요소(DOM.getFrameOwner로 찾은)의 노드 id를 알아내는 데 쓴다.
    idOf,
    // iframe 내용 영역의 화면 좌표(클릭 좌표를 프레임 안 → 바깥으로 바꿀 때)
    frameOffset(i) {
      const n = node(i);
      if (!n || !n.isConnected) return null;
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return { x: r.left + n.clientLeft + parseFloat(cs.paddingLeft), y: r.top + n.clientTop + parseFloat(cs.paddingTop) };
    },
    // 클릭할 화면 좌표. 다른 요소에 가려져 있으면 null(→ el.click()으로 대체), iframe에 가려졌으면 { covered }.
    point(i, fx, fy) {
      const orig = node(i);
      const n = tapTarget(orig);
      if (!n || !n.isConnected || !n.getBoundingClientRect) return null;
      n.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      // 폰에서 누른 자리(요소 안 비율)가 있으면 그 자리를 먼저 누른다. 큰 배경처럼 가운데가 가려진 요소 때문.
      if (n === orig && Number.isFinite(fx) && Number.isFinite(fy)) {
        const px = r.left + fx * r.width;
        const py = r.top + fy * r.height;
        const h = document.elementFromPoint(px, py);
        if (h && (h === n || n.contains(h))) return { x: px, y: py };
      }
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      // 플러그인 창(iframe)에 가려져 있으면 누르지 않는다. 폰에서 창 안을 누른 것이 잘못 와도
      // 아래 화면 버튼이 눌리지 않게(iPad 크롬에서 창이 겹겹이 열리던 문제).
      if (hit && hit.tagName === 'IFRAME' && hit !== n && !n.contains(hit)) return { covered: true };
      if (!hit || !(hit === n || n.contains(hit))) return null;
      return { x, y };
    },
    click(i) {
      let n = tapTarget(node(i));
      while (n && typeof n.click !== 'function') n = n.parentElement; // SVG 요소에는 click()이 없다
      n?.click();
    },
    focus(i) { const n = node(i); n?.focus?.(); return !!n; },
    // 플러그인 iframe(별도 프로세스) 안의 키 입력. 헤드리스 Chrome에서 실제 키 이벤트를 OOPIF로
    // 보내면 그 뒤 마우스 입력이 iframe에 닿지 않는 문제가 있어(DESIGN-frames.md) 이벤트를 직접 만든다.
    key(i, k) {
      const n = (i && node(i)) || document.activeElement || document.body;
      n.focus?.();
      const init = { key: k.key, code: k.key, bubbles: true, cancelable: true, composed: true,
        shiftKey: !!k.shift, ctrlKey: !!k.ctrl, altKey: !!k.alt, metaKey: !!k.meta };
      const go = n.dispatchEvent(new KeyboardEvent('keydown', init));
      if (go && k.key === 'Enter' && n.tagName === 'INPUT' && n.form) n.form.requestSubmit?.();
      n.dispatchEvent(new KeyboardEvent('keyup', init));
    },
    apply(ev) {
      const n = ev.i ? node(ev.i) : document.scrollingElement;
      if (!n) return;
      if (ev.type === 'scroll') { n.scrollLeft = ev.x; n.scrollTop = ev.y; return; }
      if (ev.type === 'input' || ev.type === 'change') {
        if (n.type === 'checkbox' || n.type === 'radio') n.checked = !!ev.k;
        else n.value = ev.v;
        n.dispatchEvent(new Event(ev.type, { bubbles: true }));
      }
    },
    async blob(u) {
      const r = await fetch(u);
      const b = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode.apply(null, b.subarray(k, k + 0x8000));
      return { t: r.headers.get('content-type') || 'application/octet-stream', d: btoa(s) };
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', snap, { once: true });
  else snap();
})();
