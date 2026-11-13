// 최소 CDP(Chrome DevTools Protocol) 클라이언트. Node 22 내장 WebSocket만 사용.
export class CDP {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP 연결 실패: ' + url));
    });
    return new CDP(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
        else p.res(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.rej(new Error('CDP 연결이 닫힘'));
      this.pending.clear();
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => this.pending.set(id, { res, rej, method }));
  }

  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// 탭 하나에 붙은 세션 핸들
export function session(cdp, sessionId) {
  return {
    id: sessionId,
    send: (method, params) => cdp.send(method, params, sessionId),
    on: (fn) => cdp.on((m) => { if (m.sessionId === sessionId) fn(m); }),
  };
}

export async function openPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { ...session(cdp, sessionId), targetId };
}
