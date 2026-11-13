// 종단 시험: 가짜 "리수" 페이지 → 미러 서버(Chrome #1) → 폰 역할 클라이언트(Chrome #2)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMirror } from '../src/mirror-server.mjs';
import { launchChrome } from '../src/chrome.mjs';
import { CDP, openPage } from '../src/cdp.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 리수 플러그인 v3처럼 샌드박스 srcdoc iframe으로 화면 전체를 덮는 플러그인 창
const PLUGIN = `<html><head><style>body{margin:0;background:#fff}</style></head><body>
<button id="pb">p:0</button><input id="pi"><ul id="pl"></ul><button id="pc">ask</button><button id="px">close</button>
<script>
window.__pluginRan = 1;
let k = 0;
pb.onclick = () => { pb.textContent = 'p:' + (++k); };
pi.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const li = document.createElement('li'); li.textContent = 'pm:' + pi.value; pl.appendChild(li); pi.value = ''; }
});
pc.onclick = () => { pc.textContent = confirm('계속?') ? 'yes' : 'no'; };
px.onclick = () => parent.postMessage('close', '*');
</script></body></html>`;

const FIXTURE = `<!doctype html><html class="dark"><head>
<link rel="stylesheet" href="/a.css">
<script>window.__fixtureRan = 1</script>
</head><body>
<button id="b">count:0</button>
<ul id="list"></ul>
<textarea id="t"></textarea>
<img id="img">
<img id="secure" src="/secure.png">
<button id="frame">frame</button>
<button id="plugin">plugin</button>
<script>
plugin.onclick = async () => {
  const f = document.createElement('iframe');
  f.id = 'plug';
  f.setAttribute('sandbox', 'allow-scripts allow-modals allow-downloads');
  f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:1000;background:#fff';
  f.srcdoc = await (await fetch('/plugin.html')).text();
  document.body.appendChild(f);
};
addEventListener('message', (e) => { if (e.data === 'close') document.getElementById('plug')?.remove(); });
frame.onclick = () => {
  const f = document.createElement('iframe');
  f.srcdoc = '<html><head><style>p{}</style><script>1<\\/script></head><body></body></html>';
  document.body.appendChild(f);
};
let n = 0;
b.onclick = () => { b.textContent = 'count:' + (++n); };
t.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const li = document.createElement('li');
    li.textContent = 'msg:' + t.value;
    list.appendChild(li);
    t.value = '';
  }
});
const bytes = Uint8Array.from(atob('${PNG}'), (ch) => ch.charCodeAt(0));
img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
</script></body></html>`;

let fixture, mirror, phone, phoneCdp, tab;

const evalOn = async (expr) => {
  const r = await tab.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result.value;
};
const waitFor = async (expr, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evalOn(expr)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('시간 초과: ' + expr);
};
const tap = async (sel) => {
  const p = await evalOn(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await tab.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
};

// 폰 화면의 플러그인 iframe 안 요소
const inPlug = (sel) => `document.querySelector('#plug')?.contentDocument?.querySelector(${JSON.stringify(sel)})`;
const tapInPlug = async (sel) => {
  const p = await evalOn(`(() => { const f = document.querySelector('#plug').getBoundingClientRect(); const r = ${inPlug(sel)}.getBoundingClientRect(); return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await tab.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
};

before(async () => {
  fixture = http.createServer((req, res) => {
    if (req.url === '/secure.png') {
      // 리스바드처럼 HttpOnly 세션 쿠키가 있어야만 주는 파일
      if (/(?:^|;\s*)sess=ok(?:;|$)/.test(req.headers.cookie || '')) res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from(PNG, 'base64'));
      else res.writeHead(401).end();
    } else if (req.url === '/plugin.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PLUGIN);
    } else if (req.url === '/a.css') res.writeHead(200, { 'content-type': 'text/css' }).end('#b{width:200px}');
    else res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sess=ok; Path=/; HttpOnly; SameSite=Strict' }).end(FIXTURE);
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  mirror = await startMirror({ target: `http://127.0.0.1:${fixture.address().port}/`, port: 0, host: '127.0.0.1' });
  phone = await launchChrome();
  phoneCdp = await CDP.connect(phone.wsUrl);
  tab = await openPage(phoneCdp);
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  // 폰에서 뜬 confirm()은 '확인'으로 답한다
  tab.on((m) => { if (m.method === 'Page.javascriptDialogOpening') tab.send('Page.handleJavaScriptDialog', { accept: true }); });
  await tab.send('Page.navigate', { url: `http://127.0.0.1:${mirror.port}/__parlor/` });
});

after(async () => {
  phoneCdp?.close();
  await phone?.close();
  await mirror?.close();
  fixture?.close();
});

test('첫 화면이 미러되고 리수 스크립트는 폰에서 실행되지 않음', async () => {
  await waitFor(`document.querySelector('#b')?.textContent === 'count:0'`);
  assert.equal(await evalOn(`document.documentElement.className`), 'dark');
  assert.equal(await evalOn(`typeof window.__fixtureRan`), 'undefined');
  assert.equal(await evalOn(`document.querySelectorAll('script:not([src="/__parlor/mirror.js"])').length`), 0);
});

test('서버 경유로 CSS를 받아 적용', async () => {
  await waitFor(`getComputedStyle(document.querySelector('#b')).width === '200px'`);
});

test('blob 이미지가 서버 경유 주소로 보임', async () => {
  await waitFor(`document.querySelector('#img')?.naturalWidth === 1`);
  assert.match(await evalOn(`document.querySelector('#img').getAttribute('src')`), /^\/__parlor\/blob\?u=blob%3A/);
});

test('로그인 쿠키가 필요한 파일도 서버 Chrome의 쿠키로 받아 옴', async () => {
  await waitFor(`document.querySelector('#secure')?.naturalWidth === 1`);
});

test('폰에서 누르면 서버에서 클릭되고 결과가 돌아옴', async () => {
  await tap('#b');
  await waitFor(`document.querySelector('#b').textContent === 'count:1'`);
  await tap('#b');
  await waitFor(`document.querySelector('#b').textContent === 'count:2'`);
});

test('한글 입력 후 Enter → 서버에서 전송되고 입력칸이 비워짐', async () => {
  await tap('#t');
  await tab.send('Input.insertText', { text: '안녕하세요' });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(`document.querySelector('#list li')?.textContent === 'msg:안녕하세요'`);
  await waitFor(`document.querySelector('#t').value === ''`);
  assert.equal(await mirror.evaluate(`document.querySelector('#list').children.length`), 1);
});

test('iframe이 생겨도 폰 화면이 iframe 문서로 바뀌지 않음', async () => {
  await tap('#frame');
  await waitFor(`document.querySelector('iframe') !== null`);
  // iframe 쪽 스냅샷이 오면 화면이 통째로 바뀌므로 잠깐 기다린 뒤 확인
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await evalOn(`document.querySelector('#b')?.textContent`), 'count:2');
  assert.equal(await evalOn(`document.body?.parentNode === document.documentElement`), true);
});

test('플러그인 iframe 내용이 폰에 보이고, 플러그인 스크립트는 폰에서 실행되지 않음', async () => {
  await tap('#plugin');
  await waitFor(`${inPlug('#pb')}?.textContent === 'p:0'`);
  assert.equal(await evalOn(`typeof document.querySelector('#plug').contentWindow.__pluginRan`), 'undefined');
  assert.equal(await evalOn(`document.querySelector('#plug').getAttribute('sandbox')`), 'allow-same-origin');
});

test('플러그인 iframe 안을 누르면 서버 iframe에서 클릭되고 결과가 돌아옴', async () => {
  await tapInPlug('#pb');
  await waitFor(`${inPlug('#pb')}.textContent === 'p:1'`);
});

test('플러그인 iframe 안에서 한글 입력 후 Enter', async () => {
  await tapInPlug('#pi');
  await tab.send('Input.insertText', { text: '플러그인' });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(`${inPlug('#pl li')}?.textContent === 'pm:플러그인'`);
});

test('플러그인의 confirm()이 폰에 뜨고, 폰의 답이 서버로 돌아감', async () => {
  await tapInPlug('#pc');
  await waitFor(`${inPlug('#pc')}.textContent === 'yes'`);
});

test('폰을 새로 열어도 플러그인 iframe 내용이 복원됨', async () => {
  await tab.send('Page.reload');
  await waitFor(`${inPlug('#pb')}?.textContent === 'p:1'`);
});

test('플러그인 창을 닫으면 폰에서도 사라지고 아래 화면을 다시 누를 수 있음', async () => {
  await tapInPlug('#px');
  await waitFor(`document.querySelector('#plug') === null`);
  await tap('#b');
  await waitFor(`document.querySelector('#b').textContent === 'count:3'`);
});

test('토큰을 설정하면 토큰 없이 접근할 수 없음', async () => {
  const m2 = await startMirror({ target: `http://127.0.0.1:${fixture.address().port}/`, port: 0, host: '127.0.0.1', token: 'secret' });
  try {
    const base = `http://127.0.0.1:${m2.port}`;
    assert.equal((await fetch(base + '/__parlor/')).status, 401);
    const ok = await fetch(base + '/__parlor/?token=secret');
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/a.css', { headers: { cookie } })).status, 200);
  } finally {
    await m2.close();
  }
});
