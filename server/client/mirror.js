// 폰 쪽 미러 클라이언트. 서버가 보낸 DOM을 그리기만 하고, 리수 스크립트는 실행하지 않는다.
// 프레임(플러그인 iframe)마다 Doc 하나. 최상위는 키 'top'. (DESIGN-frames.md)
(() => {
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

  // 지금 입력 중인 칸은 내가 보낸 값의 메아리라면 덮어쓰지 않는다.
  const posted = new WeakMap();
  const remember = (n, v) => {
    let s = posted.get(n);
    if (!s) posted.set(n, (s = []));
    s.push(v);
    if (s.length > 30) s.shift();
  };
  let composing = false;
  const lastScroll = new WeakMap();

  const drag = { on: false, suppress: false };

  // ── 미러 안내 화면: 서버에서만 일어나는 일(파일 창·다운로드·복사)을 폰에서 이어 받는다 ──
  // 미러된 DOM이 통째로 바뀌어도 살아남도록 Shadow DOM 호스트를 매번 다시 붙인다.
  const UI = (() => {
    const host = document.createElement('div');
    host.id = '__parlor-ui';
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .box{pointer-events:auto;margin:10px;padding:12px 14px;border-radius:12px;background:#1f2430;color:#eee;
        font:15px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .box b{flex:1 1 auto} a,button,label{font:inherit;color:#fff;background:#3b82f6;border:0;border-radius:8px;padding:8px 12px;text-decoration:none;cursor:pointer}
      button.x{background:#444} input[type=file]{max-width:100%;color:#ccc}
      #clip{white-space:pre-wrap;max-height:30vh;overflow:auto;flex-basis:100%;font-size:13px;color:#bbb}
    </style><div id="list"></div>`;
    const list = root.getElementById('list');
    const ensure = () => { if (!host.isConnected) document.documentElement.appendChild(host); };
    const box = (html, id) => {
      ensure();
      if (id) root.getElementById(id)?.remove();
      const el = document.createElement('div');
      el.className = 'box';
      if (id) el.id = id;
      el.innerHTML = html;
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '닫기';
      x.onclick = () => el.remove();
      el.append(x);
      list.append(el);
      return el;
    };
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    return {
      ensure,
      owns: (t) => t === host,
      file(op) {
        const el = box(`<b>파일을 골라 주세요</b><input type="file" ${op.multiple ? 'multiple' : ''} accept="${esc(op.accept || '')}">`, 'file');
        const inp = el.querySelector('input');
        let sent = false;
        el.querySelector('.x').onclick = () => { el.remove(); if (!sent) post('upload-done', { id: op.id, cancel: true }); };
        inp.onchange = async () => {
          sent = true;
          const files = [...inp.files];
          el.querySelector('b').textContent = '올리는 중…';
          for (let i = 0; i < files.length; i++) {
            const q = new URLSearchParams({ id: op.id, i, name: files[i].name });
            await fetch('/__parlor/upload?' + q, { method: 'POST', body: files[i] });
          }
          await post('upload-done', { id: op.id, n: files.length });
          el.remove();
        };
      },
      download(op) {
        box(`<b>파일 받기</b><a href="/__parlor/download/${encodeURIComponent(op.id)}" download="${esc(op.name)}">${esc(op.name)}</a>`, 'dl-' + op.id);
      },
      clip(text) {
        const el = box(`<b>복사됨</b><div id="clip">${esc(text)}</div>`, 'clipbox');
        // 폰 클립보드에 바로 넣어 본다. 사용자 동작 없이 막히면 버튼으로 다시 시도.
        navigator.clipboard?.writeText(text).catch(() => {
          const b = document.createElement('button');
          b.textContent = '폰에 복사';
          b.onclick = () => navigator.clipboard?.writeText(text).then(() => { el.querySelector('b').textContent = '폰에 복사됨'; b.remove(); });
          el.insertBefore(b, el.querySelector('.x'));
        });
        setTimeout(() => el.remove(), 8000);
      },
    };
  })();

  const docs = new Map(); // 프레임 키 → Doc
  const pendingOps = new Map(); // 아직 iframe과 연결 안 된 프레임의 메시지
  const links = new Map(); // 프레임 키 → { parent: 부모 Doc, owner: 부모 문서의 iframe 노드 id }

  function Doc(key, document) {
    const nodes = new Map(); // 서버 id → 노드
    const idOf = new WeakMap(); // 노드 → 서버 id
    let detached = new Set();
    const BASE = document.createElement('base');
    BASE.href = location.origin + '/';

    const reg = (id, n) => { nodes.set(id, n); idOf.set(n, id); };
    const setAttrs = (el, attrs) => {
      for (const a of [...el.attributes]) el.removeAttribute(a.name);
      for (const [k, v] of attrs) try { el.setAttribute(k, v); } catch {}
    };

    // iframe은 폰에서 같은 출처 빈 문서로 만들고, 내용은 프레임 메시지로 채운다.
    // sandbox는 걸지 않는다: WebKit(iPad·iPhone)은 스크립트 금지 iframe 안에서 부모가 단 이벤트 처리기도
    // 실행하지 않아 입력이 전달되지 않는다. 스크립트·on* 속성은 서버 에이전트가 애초에 보내지 않는다.
    const FRAME_ATTR = /^(src|srcdoc|sandbox)$/i;
    // draggable도 빼서 폰 브라우저 자체 드래그가 끼어들지 않게 한다(드래그는 서버에서 실제로 일어남).
    const safeAttr = (el, k) => !(el.localName === 'iframe' && FRAME_ATTR.test(k)) && k !== 'draggable';
    function prepFrame(el) {
      // 다른 곳으로 옮겨지면 iframe 문서가 새로 만들어지므로, 그때 서버에 다시 그려 달라고 한다.
      el.addEventListener('load', () => relink(el));
    }

    function setVal(n, o) {
      if (n.type === 'checkbox' || n.type === 'radio') { n.checked = !!o.k; return; }
      if (n.value === o.v) return;
      if (n === document.activeElement && (composing || (posted.get(n) || []).includes(o.v))) return;
      n.value = o.v;
    }

    function build(o) {
      let n;
      if (o.t === 3) n = document.createTextNode(o.v);
      else if (o.t !== 1) n = document.createComment('');
      else {
        try {
          n = o.ns ? document.createElementNS(o.ns, o.n) : document.createElement(o.n);
          for (const [k, v] of o.a) if (safeAttr(n, k)) try { n.setAttribute(k, v); } catch {}
          if (n.localName === 'iframe') prepFrame(n);
          for (const c of o.c) n.appendChild(build(c));
          if ('v' in o) setVal(n, o);
        } catch {
          n = document.createComment('');
        }
      }
      reg(o.i, n);
      return n;
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
      if (key === 'top') document.title = op.title || 'Dusk Parlor';
    }

    function apply(op) {
      if (op.op === 'snap') return applySnap(op);
      if (op.op === 'frame') { links.set(op.key, { parent: doc, owner: op.owner }); return; }
      if (op.op === 'dialog') return showDialog(op);
      if (op.op === 'file') return UI.file(op);
      if (op.op === 'download') return UI.download(op);
      if (op.op === 'clip') return UI.clip(op.text);
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
        if (n.nodeType !== 1 || !safeAttr(n, op.k)) return;
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

    function run(ops) {
      detached = new Set();
      for (const op of ops) try { apply(op); } catch (err) { console.warn('[parlor]', err); }
      for (const n of detached) forget(n);
    }

    // ── 폰 → 서버 ──
    const idFor = (n) => { while (n && !idOf.has(n)) n = n.parentNode; return n ? idOf.get(n) : 0; };

    function sendVal(n, type = 'input') {
      const i = idOf.get(n);
      if (!i || !('value' in n)) return;
      remember(n, n.value);
      post('event', { f: key, type, i, v: n.value, k: !!n.checked });
    }

    const FWD = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    const NOT_TEXT = /^(checkbox|radio|button|submit|reset|image|file|range|color|hidden)$/i;
    const editable = (t) => t instanceof document.defaultView.Element &&
      ((t.tagName === 'INPUT' && !NOT_TEXT.test(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

    function wire() {
      document.addEventListener('click', (e) => {
        if (UI.owns(e.target)) return; // 미러 안내 화면(파일 선택·받기)은 폰에서 그대로 동작
        if (drag.suppress) { e.preventDefault(); e.stopPropagation(); return; }
        // 링크 이동·체크 토글은 서버가 하고 결과만 받는다. 단 입력칸은 기본 동작(포커스·커서 이동)을 막지 않는다:
        // iOS WebKit은 click 단계에서 포커스를 옮기는데, 막으면 키보드가 열린 채 다른 칸을 눌러도
        // 이전 칸에 포커스가 남아 글자가 엉뚱한 칸에 들어간다(직접 focus()를 불러도 iOS가 되돌림).
        if (editable(e.target)) { if (document.activeElement !== e.target) e.target.focus(); }
        else e.preventDefault();
        let n = e.target;
        while (n && !idOf.has(n)) n = n.parentNode;
        if (!n) return;
        // 누른 위치를 요소 안 비율로 보낸다(서버 화면에서 같은 자리를 누르도록).
        const ev = { f: key, type: 'click', i: idOf.get(n) };
        const r = n.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0 && (e.clientX || e.clientY)) {
          ev.fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          ev.fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
        }
        post('event', ev);
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
        post('event', { f: key, type: 'key', i: idOf.get(t) || 0, key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
      }, true);

      // 드래그: 마우스는 바로, 터치는 꾹 누른(300ms) 뒤 움직이면 드래그. 짧게 밀면 그냥 스크롤.
      let start = null;
      let last = 0;
      let lastPt = null;
      let tail = null;
      const sendMove = () => {
        tail = null;
        if (!lastPt || !drag.on) return;
        last = performance.now();
        post('event', { f: key, type: 'drag', phase: 'move', x: lastPt.x, y: lastPt.y });
      };
      document.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || UI.owns(e.target)) return;
        start = { x: e.clientX, y: e.clientY, t: performance.now(), mouse: e.pointerType === 'mouse' };
      }, true);
      document.addEventListener('pointermove', (e) => {
        if (!start) return;
        const pt = { x: e.clientX, y: e.clientY };
        if (!drag.on) {
          if (Math.hypot(pt.x - start.x, pt.y - start.y) < 8) return;
          if (!start.mouse && performance.now() - start.t < 300) { start = null; return; }
          drag.on = true;
          post('event', { f: key, type: 'drag', phase: 'start', x: start.x, y: start.y });
        }
        lastPt = pt;
        if (performance.now() - last >= 40) sendMove();
        else if (!tail) tail = setTimeout(sendMove, 40);
      }, true);
      const end = (e) => {
        if (drag.on) {
          clearTimeout(tail);
          sendMove();
          post('event', { f: key, type: 'drag', phase: 'end', x: e.clientX, y: e.clientY });
          drag.suppress = true;
          setTimeout(() => { drag.suppress = false; }, 400);
        }
        drag.on = false;
        start = null;
      };
      document.addEventListener('pointerup', end, true);
      document.addEventListener('pointercancel', end, true);
      // 드래그 중에는 폰 화면이 스크롤되지 않게
      document.addEventListener('touchmove', (e) => { if (drag.on) e.preventDefault(); }, { capture: true, passive: false });
      document.addEventListener('dragstart', (e) => e.preventDefault(), true);

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
          post('event', { f: key, type: 'scroll', i, x: t.scrollLeft, y: t.scrollTop });
        }, 60));
      }, true);
    }

    const doc = { key, document, nodes, run, wire };
    return doc;
  }

  // 연결 정보(frame op)와 iframe 요소가 모두 준비된 프레임을 붙인다.
  function attachFrames() {
    for (const [key, l] of links) {
      const el = l.parent.nodes.get(l.owner);
      if (!el || el.localName !== 'iframe' || !el.isConnected || !el.contentDocument) continue;
      const cur = docs.get(key);
      if (cur && cur.document === el.contentDocument) continue;
      const d = Doc(key, el.contentDocument);
      el.__parlorKey = key;
      d.wire();
      docs.set(key, d);
      const q = pendingOps.get(key);
      pendingOps.delete(key);
      if (q) for (const ops of q) d.run(ops);
      else if (cur) post('resnap', { f: key }); // 문서가 바뀌었는데 쌓인 내용이 없으면 다시 받는다
    }
  }

  function relink(el) {
    const key = el.__parlorKey;
    if (!key) return attachFrames();
    const cur = docs.get(key);
    if (cur && cur.document !== el.contentDocument) {
      docs.delete(key);
      attachFrames();
      post('resnap', { f: key });
    }
  }

  function showDialog(op) {
    // 메시지 처리 중에 막지 않도록 다음 틱에 띄운다.
    setTimeout(() => {
      let accept = true;
      let text = '';
      if (op.type === 'confirm') accept = confirm(op.message);
      else if (op.type === 'prompt') { const v = prompt(op.message, op.value); accept = v !== null; text = v ?? ''; }
      else alert(op.message);
      fetch('/__parlor/dialog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept, text }) }).catch(() => {});
    });
  }

  function onMessage(msg) {
    const d = docs.get(msg.f);
    if (d) d.run(msg.ops);
    else {
      let q = pendingOps.get(msg.f);
      if (!q) pendingOps.set(msg.f, (q = []));
      if (msg.ops.some((op) => op.op === 'snap')) q.length = 0; // 새 스냅샷이면 이전 것은 필요 없음
      q.push(msg.ops);
    }
    attachFrames();
    UI.ensure();
  }

  const top = Doc('top', document);
  docs.set('top', top);
  top.wire();

  let rz;
  const sendViewport = () => post('viewport', { w: innerWidth, h: innerHeight });
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(sendViewport, 150); });
  sendViewport();

  const es = new EventSource('/__parlor/stream');
  es.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg && Array.isArray(msg.ops)) onMessage(msg);
  };
  // EventSource가 알아서 다시 붙고, 붙을 때마다 서버가 전체 화면을 다시 보낸다.
})();
