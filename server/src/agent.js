// 서버 Chrome의 리수 페이지 안에 주입되는 스크립트.
// DOM을 직렬화하고, 바뀐 부분만 __parlorEmit 바인딩으로 내보낸다.
(() => {
  // 같은 출처 iframe(about:srcdoc 등)에도 주입되므로 최상위 문서에서만 동작한다.
  // 그러지 않으면 iframe의 snap이 폰 화면 전체를 덮어쓴다.
  if (window.__parlor || window !== window.top) return;
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
    for (const at of n.attributes) if (!/^on/i.test(at.name)) a.push([at.name, fix(at.value)]);
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
        if (/^on/i.test(r.attributeName) || skipped.has(t)) continue;
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

  window.__parlor = {
    snap,
    node,
    // 클릭할 화면 좌표. 다른 요소에 가려져 있으면 null(→ el.click()으로 대체).
    point(i) {
      const n = node(i);
      if (!n || !n.isConnected || !n.getBoundingClientRect) return null;
      n.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === n || n.contains(hit))) return null;
      return { x, y };
    },
    click(i) { node(i)?.click?.(); },
    focus(i) { const n = node(i); n?.focus?.(); return !!n; },
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
