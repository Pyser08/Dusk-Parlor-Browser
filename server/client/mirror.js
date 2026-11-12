// 폰 쪽 미러 클라이언트. 서버가 보낸 DOM을 그리기만 하고, 리수 스크립트는 실행하지 않는다.
(() => {
  const nodes = new Map(); // 서버 id → 노드
  const idOf = new WeakMap(); // 노드 → 서버 id
  const BASE = document.createElement('base');
  BASE.href = '/';
  let detached = new Set();

  // 입력은 순서가 중요하니 한 줄로 세워 보낸다.
  let chain = Promise.resolve();
  const post = (path, body) => {
    chain = chain.then(() => fetch('/__parlor/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).catch(() => {});
    return chain;
  };

  const reg = (id, n) => { nodes.set(id, n); idOf.set(n, id); };
  const setAttrs = (el, attrs) => {
    for (const a of [...el.attributes]) el.removeAttribute(a.name);
    for (const [k, v] of attrs) try { el.setAttribute(k, v); } catch {}
  };

  function build(o) {
    let n;
    if (o.t === 3) n = document.createTextNode(o.v);
    else if (o.t !== 1) n = document.createComment('');
    else {
      try {
        n = o.ns ? document.createElementNS(o.ns, o.n) : document.createElement(o.n);
        for (const [k, v] of o.a) try { n.setAttribute(k, v); } catch {}
        for (const c of o.c) n.appendChild(build(c));
        if ('v' in o) setVal(n, o);
      } catch {
        n = document.createComment('');
      }
    }
    reg(o.i, n);
    return n;
  }

  // 지금 입력 중인 칸은 내가 보낸 값의 메아리라면 덮어쓰지 않는다.
  const posted = new WeakMap();
  const remember = (n, v) => {
    let s = posted.get(n);
    if (!s) posted.set(n, (s = []));
    s.push(v);
    if (s.length > 30) s.shift();
  };
  let composing = false;
  function setVal(n, o) {
    if (n.type === 'checkbox' || n.type === 'radio') { n.checked = !!o.k; return; }
    if (n.value === o.v) return;
    if (n === document.activeElement && (composing || (posted.get(n) || []).includes(o.v))) return;
    n.value = o.v;
  }

  function setKids(p, arr) {
    const want = new Set(arr);
    for (const ch of [...p.childNodes]) if (!want.has(ch)) { p.removeChild(ch); detached.add(ch); }
    let cur = p.firstChild;
    for (const n of arr) {
      if (n === cur) cur = cur.nextSibling;
      else p.insertBefore(n, cur);
    }
  }

  function applySnap(op) {
    nodes.clear();
    const html = document.documentElement;
    setAttrs(html, op.root.a);
    reg(op.root.i, html);
    const kids = op.root.c.map((c) => {
      if (c.t === 1 && (c.n === 'head' || c.n === 'body')) {
        const el = c.n === 'head' ? document.head : document.body;
        setAttrs(el, c.a);
        const arr = c.c.map(build);
        if (el === document.head) arr.unshift(BASE);
        el.replaceChildren(...arr);
        reg(c.i, el);
        return el;
      }
      return build(c);
    });
    html.replaceChildren(...kids);
    document.title = op.title || 'Dusk Parlor';
  }

  const lastScroll = new WeakMap();
  function apply(op) {
    if (op.op === 'snap') return applySnap(op);
    if (op.op === 'kids') {
      const p = nodes.get(op.p);
      if (!p) return;
      const arr = [];
      for (const c of op.c) {
        const n = 'r' in c ? nodes.get(c.r) : build(c);
        if (n) arr.push(n);
      }
      if (p === document.head) arr.unshift(BASE);
      setKids(p, arr);
      return;
    }
    const n = nodes.get(op.i);
    if (!n) return;
    if (op.op === 'attr') {
      if (n.nodeType !== 1) return;
      if (op.v == null) n.removeAttribute(op.k);
      else try { n.setAttribute(op.k, op.v); } catch {}
    } else if (op.op === 'text') {
      if (n.nodeType === 3 || n.nodeType === 8) n.data = op.v;
    } else if (op.op === 'val') {
      if ('value' in n) setVal(n, op);
    } else if (op.op === 'scroll') {
      lastScroll.set(n, { x: op.x, y: op.y });
      n.scrollLeft = op.x;
      n.scrollTop = op.y;
    }
  }

  function forget(n) {
    if (n.isConnected) return;
    const i = idOf.get(n);
    if (i && nodes.get(i) === n) nodes.delete(i);
    for (const c of n.childNodes) forget(c);
  }

  // ── 폰 → 서버 ──
  const idFor = (n) => { while (n && !idOf.has(n)) n = n.parentNode; return n ? idOf.get(n) : 0; };

  function sendVal(n, type = 'input') {
    const i = idOf.get(n);
    if (!i || !('value' in n)) return;
    remember(n, n.value);
    post('event', { type, i, v: n.value, k: !!n.checked });
  }

  const FWD = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  function wire() {
    document.addEventListener('click', (e) => {
      e.preventDefault(); // 링크 이동·체크 토글은 서버가 하고 결과만 받는다
      const i = idFor(e.target);
      if (i) post('event', { type: 'click', i });
    }, true);
    document.addEventListener('submit', (e) => e.preventDefault(), true);

    document.addEventListener('compositionstart', () => { composing = true; }, true);
    document.addEventListener('compositionend', (e) => { composing = false; sendVal(e.target); }, true);
    document.addEventListener('input', (e) => { if (!composing && !e.isComposing) sendVal(e.target); }, true);
    document.addEventListener('change', (e) => sendVal(e.target, 'change'), true);

    document.addEventListener('keydown', (e) => {
      if (!FWD.has(e.key) || e.isComposing || composing) return;
      const t = e.target;
      const multiline = t.tagName === 'TEXTAREA';
      if (e.key === 'Tab' || (e.key === 'Enter' && !(multiline && e.shiftKey))) e.preventDefault();
      if ('value' in t) { sendVal(t); posted.delete(t); }
      post('event', { type: 'key', i: idOf.get(t) || 0, key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
    }, true);

    const timers = new WeakMap();
    document.addEventListener('scroll', (e) => {
      const t = e.target === document ? document.scrollingElement : e.target;
      const i = t && idOf.get(t);
      if (!i || timers.has(t)) return;
      timers.set(t, setTimeout(() => {
        timers.delete(t);
        const l = lastScroll.get(t);
        if (l && l.x === t.scrollLeft && l.y === t.scrollTop) return;
        lastScroll.set(t, { x: t.scrollLeft, y: t.scrollTop });
        post('event', { type: 'scroll', i, x: t.scrollLeft, y: t.scrollTop });
      }, 60));
    }, true);

    let rz;
    const sendViewport = () => post('viewport', { w: innerWidth, h: innerHeight });
    addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(sendViewport, 150); });
    sendViewport();
  }

  function connect() {
    const es = new EventSource('/__parlor/stream');
    es.onmessage = (m) => {
      let ops;
      try { ops = JSON.parse(m.data); } catch { return; }
      detached = new Set();
      for (const op of ops) try { apply(op); } catch (err) { console.warn('[parlor]', err); }
      for (const n of detached) forget(n);
    };
    // EventSource가 알아서 다시 붙고, 붙을 때마다 서버가 전체 화면을 다시 보낸다.
  }

  wire();
  connect();
})();
