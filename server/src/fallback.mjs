// 미러를 켜지 못했을 때(Chrome이 안 뜨는 등) 대신 쓰는 아주 작은 서버.
// 원래 리스 포트를 쥐고 있으므로 이게 없으면 리스까지 끊긴다 → 리스로는 그대로 넘기고, /__parlor 만 안내를 보여 준다.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

export function startFallback({ target, port, host, reason }) {
  const t = new URL(target);
  const tport = Number(t.port) || (t.protocol === 'https:' ? 443 : 80);
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/__parlor')) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<body style="font:16px/1.6 system-ui,sans-serif;background:#111;color:#ddd;padding:24px">` +
        `<h2>미러를 켜지 못했어요</h2><p>리스는 그대로 쓸 수 있어요(주소에서 /__parlor 를 빼세요). 1분마다 다시 시도해요.</p>` +
        `<pre style="white-space:pre-wrap;color:#f4867a">${String(reason).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre></body>`);
      return;
    }
    const headers = { ...req.headers, host: t.host };
    const mod = t.protocol === 'https:' ? await import('node:https') : http;
    const up = mod.request({ host: t.hostname, port: tport, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => { if (!res.headersSent) res.writeHead(502).end(String(e.message)); else res.end(); });
    req.pipe(up);
  });
  server.on('upgrade', (req, sock, head) => {
    const up = t.protocol === 'https:' ? tls.connect(tport, t.hostname, { servername: t.hostname }) : net.connect(tport, t.hostname);
    up.once(t.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i].toLowerCase() === 'host' ? t.host : req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    const end = () => { up.destroy(); sock.destroy(); };
    up.on('error', end); sock.on('error', end);
  });
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, host, () => ok({ close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}
