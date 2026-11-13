// 종단 시험: 가짜 "리수" 페이지 → 미러 서버(Chrome #1) → 폰 역할 클라이언트(Chrome #2)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { startMirror } from '../src/mirror-server.mjs';
import { launchChrome } from '../src/chrome.mjs';
import { CDP, openPage } from '../src/cdp.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 아주 짧은 무음 WAV(8kHz, 8bit, 10샘플)
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([46, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x40, 0x1f, 0, 0, 1, 0, 8, 0]), Buffer.from('data'), Buffer.from([10, 0, 0, 0]), Buffer.alloc(10, 128)]);

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
<div id="io" style="display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start">
<button id="pick">pick</button><span id="picked">-</span><button id="pickjs">pickjs</button>
<button id="save">save</button>
<button id="copy">copy</button>
<ul id="dl" style="list-style:none;padding:0;margin:0;width:200px">
<li id="d1" draggable="true" style="height:40px;background:#ddd">A</li>
<li id="d2" draggable="true" style="height:40px;background:#bbb">B</li>
</ul><span id="dorder">AB</span>
<div id="pad" style="position:relative;width:300px;height:60px;background:#eef">
  <div id="cover" style="position:absolute;left:0;top:0;width:200px;height:60px;background:#fcc"></div>
</div><span id="padcount">pad:0</span>
<div id="ce" contenteditable="true" style="min-height:20px;width:200px;border:1px solid #999"></div><span id="ceout">-</span>
<div id="ctx" style="width:120px;height:30px;background:#cfc">ctx</div><span id="ctxout">ctx:0</span>
<button id="win">win</button><button id="noti">noti</button><button id="snd">snd</button>
<canvas id="cv" width="40" height="20" style="border:1px solid #000"></canvas><button id="draw">draw</button>
<div id="hov" style="width:80px;height:24px;background:#ccf">hov</div><span id="hovout">hov:0</span>
<button id="paste">paste</button><span id="pasted">-</span>
</div>
<button id="b">count:0</button>
<ul id="list"></ul>
<textarea id="t"></textarea>
<img id="img">
<img id="secure" src="/secure.png">
<button id="frame">frame</button>
<button id="plugin">plugin</button>
<button id="icon" style="padding:8px"><svg width="24" height="24" viewBox="0 0 24 24" stroke="black"><path id="iconline" d="M12 5v14"/><path d="M5 12h14"/></svg></button>
<span id="iconcount">icon:0</span>
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
// 파일 가져오기: 리수처럼 문서에 붙이지 않은 input[type=file]을 만들어 연다
pick.onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.txt';
  inp.onchange = async () => { const f = inp.files[0]; picked.textContent = f.name + ':' + (await f.text()); };
  inp.click();
};
// 리수 플러그인 가져오기처럼 .js 파일 창
pickjs.onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.js';
  inp.onchange = async () => { const f = inp.files[0]; picked.textContent = f.name + ':' + (await f.text()); };
  inp.click();
};
// 파일 내보내기: blob 링크 다운로드
save.onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['다운로드 내용'], { type: 'text/plain' }));
  a.download = '결과.txt';
  a.click();
};
copy.onclick = () => navigator.clipboard.writeText('복사-123').catch(() => {});
// 드래그로 순서 바꾸기(네이티브 드래그 앤 드롭)
const order = () => { dorder.textContent = [...dl.children].map((li) => li.textContent).join(''); };
let dragged = null;
for (const li of dl.children) {
  li.addEventListener('dragstart', (e) => { dragged = li; e.dataTransfer.setData('text/plain', li.id); });
  li.addEventListener('dragover', (e) => e.preventDefault());
  li.addEventListener('drop', (e) => { e.preventDefault(); if (dragged && dragged !== li) { li.after(dragged); order(); } });
}
let hv = 0;
hov.addEventListener('mouseenter', () => { hovout.textContent = 'hov:' + (++hv); });
paste.onclick = () => navigator.clipboard.readText().then((t) => { pasted.textContent = t; }, (e) => { pasted.textContent = 'err:' + e.message; });
ce.addEventListener('input', () => { ceout.textContent = ce.textContent; });
let cx = 0;
ctx.addEventListener('contextmenu', (e) => { e.preventDefault(); ctxout.textContent = 'ctx:' + (++cx); });
win.onclick = () => window.open('/newpage');
noti.onclick = () => new Notification('완료', { body: '응답 도착' });
snd.onclick = () => {
  new Audio('/beep.wav').play().catch(() => {});
  speechSynthesis.speak(new SpeechSynthesisUtterance('안녕하세요'));
};
draw.onclick = () => { const g = cv.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 40, 20); };
// 리수의 배경 닫기처럼 pointerdown으로만 반응하고, 가운데는 다른 요소에 가려진 큰 요소
let pc = 0;
pad.addEventListener('pointerdown', (e) => { if (e.target === pad) padcount.textContent = 'pad:' + (++pc); });
let ic = 0;
icon.onclick = () => { iconcount.textContent = 'icon:' + (++ic); };
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

const loginCookie = async () => {
  const r = await fetch(`http://127.0.0.1:${mirror.port}/__parlor/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  return r.headers.get('set-cookie').split(';')[0];
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
    if (req.url === '/api/login' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        // 리수처럼 해시(SHA-256 hex)한 비밀번호만 받는다
        const ok = JSON.parse(b || '{}').password === createHash('sha256').update('pw').digest('hex');
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { status: 'success' } : { error: 'Password incorrect' }));
      });
      return;
    }
    if (req.url === '/echo') {
      // 리수로 그대로 넘어왔는지 확인용: 방법·본문·쿠키를 돌려줌
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ m: req.method, b, cookie: req.headers.cookie || '' })));
      return;
    }
    if (req.url === '/secure.png') {
      // 리스바드처럼 HttpOnly 세션 쿠키가 있어야만 주는 파일
      if (/(?:^|;\s*)sess=ok(?:;|$)/.test(req.headers.cookie || '')) res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from(PNG, 'base64'));
      else res.writeHead(401).end();
    } else if (req.url === '/dusk.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end('//@name dusk_atelier');
    } else if (req.url === '/beep.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav' }).end(WAV);
    } else if (req.url === '/newpage') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>new</p>');
    } else if (req.url === '/plugin.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PLUGIN);
    } else if (req.url === '/a.css') res.writeHead(200, { 'content-type': 'text/css' }).end('#b{width:200px}');
    else res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sess=ok; Path=/; HttpOnly; SameSite=Strict' }).end(FIXTURE);
  });
  // 웹소켓 대신: Upgrade를 받으면 101 뒤 받은 바이트를 그대로 돌려줌
  fixture.on('upgrade', (req, sock) => {
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    sock.pipe(sock);
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  mirror = await startMirror({ target: `http://127.0.0.1:${fixture.address().port}/`, port: 0, host: '127.0.0.1', dusk: { url: `http://127.0.0.1:${fixture.address().port}/dusk.js` } });
  phone = await launchChrome();
  phoneCdp = await CDP.connect(phone.wsUrl);
  tab = await openPage(phoneCdp);
  await tab.send('Runtime.enable');
  if (process.env.PHONE_LOG) tab.on((m) => { if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params.type !== 'log')) console.error('[폰]', JSON.stringify(m.params).slice(0, 300)); });
  await tab.send('Page.enable');
  // 폰에서 뜬 confirm()은 '확인'으로 답한다
  tab.on((m) => { if (m.method === 'Page.javascriptDialogOpening') tab.send('Page.handleJavaScriptDialog', { accept: true }); });
  await tab.send('Page.navigate', { url: `http://127.0.0.1:${mirror.port}/__parlor/` });
  // 처음엔 리수 비밀번호를 묻는다
  await waitFor(`!!document.querySelector('#pw')`);
  await evalOn(`document.querySelector('#pw').value = 'pw'; document.querySelector('#f').requestSubmit()`);
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

test('아이콘 버튼의 선(폭 0인 SVG path)을 눌러도 서버 버튼이 눌림', async () => {
  // 터치는 아이콘 안의 path가 눌린 요소로 잡힌다. 리수의 +·X·연필 같은 아이콘 버튼이 안 눌리던 문제.
  await waitFor(`document.querySelector('#iconline') !== null`);
  await evalOn(`document.querySelector('#iconline').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
  await waitFor(`document.querySelector('#iconcount').textContent === 'icon:1'`);
});

test('iOS처럼 click만 와도 누른 입력칸으로 폰 포커스가 옮겨짐', async () => {
  // iOS WebKit은 터치의 click 단계에서 포커스를 준다. 미러가 click 기본 동작을 막으면
  // 키보드가 열린 채 다른 칸을 눌러도 포커스가 안 옮겨져 글자가 엉뚱한 칸에 들어갔다.
  await evalOn(`document.querySelector('#b').focus()`);
  await evalOn(`document.querySelector('#t').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
  assert.equal(await evalOn(`document.activeElement?.id`), 't');
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
  // WebKit(iPad·iPhone)은 sandbox iframe 안에서 부모가 단 이벤트 처리기를 실행하지 않으므로 sandbox를 걸지 않는다.
  // 스크립트는 서버 에이전트가 애초에 보내지 않는다(위 __pluginRan 검사).
  assert.equal(await evalOn(`document.querySelector('#plug').hasAttribute('sandbox')`), false);
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

test('플러그인 창에 가려진 아래 화면 요소는 클릭 요청이 와도 누르지 않음', async () => {
  // iPad 크롬에서 플러그인 안을 누른 것이 최상위 클릭으로 와서, 가려진 리수 버튼이 눌리던 문제
  const i = await mirror.evaluate(`__parlor.idOf(document.querySelector('#b'))`);
  const r = await fetch(`http://127.0.0.1:${mirror.port}/__parlor/event`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-parlor-sid': mirror.sid, cookie: await loginCookie() }, body: JSON.stringify({ f: 'top', type: 'click', i }),
  });
  assert.equal(r.status, 204);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(await mirror.evaluate(`document.querySelector('#b').textContent`), 'count:2');
});

test('플러그인 창을 닫으면 폰에서도 사라지고 아래 화면을 다시 누를 수 있음', async () => {
  await tapInPlug('#px');
  await waitFor(`document.querySelector('#plug') === null`);
  await tap('#b');
  await waitFor(`document.querySelector('#b').textContent === 'count:3'`);
});

// 폰 미러의 안내 화면(파일 선택·받기·복사 알림)
const ui = (sel) => `document.querySelector('#__parlor-ui')?.shadowRoot?.querySelector(${JSON.stringify(sel)})`;

test('누른 위치 그대로 서버에서 누름(요소 가운데가 아니라)', async () => {
  const p = await evalOn(`(() => { const r = document.querySelector('#pad').getBoundingClientRect(); return { x: r.left + 260, y: r.top + 30 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await tab.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  await waitFor(`document.querySelector('#padcount').textContent === 'pad:1'`);
});

test('파일 가져오기: 서버의 파일 창 대신 폰에서 고른 파일이 들어감', async () => {
  await tap('#pick');
  await waitFor(`!!${ui('input[type=file]')}`);
  const file = path.join(os.tmpdir(), 'parlor-a.txt');
  writeFileSync(file, '안녕 파일');
  const { result } = await tab.send('Runtime.evaluate', { expression: ui('input[type=file]') });
  await tab.send('DOM.getDocument');
  await tab.send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId });
  await waitFor(`document.querySelector('#picked').textContent === 'parlor-a.txt:안녕 파일'`);
});

test('처음 접속하면 Dusk Atelier 설치 안내가 뜨고, "다시 안 보기"를 누르면 다시 안 뜸', async () => {
  await waitFor(`!!${ui('#duskhint')}`);
  await evalOn(`${ui('#duskhint .never')}.click()`);
  await waitFor(`!${ui('#duskhint')}`);
  await new Promise((r) => setTimeout(r, 300));
  await tab.send('Page.reload');
  await waitFor(`!!document.querySelector('#b')`);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await evalOn(`!!${ui('#duskhint')}`), false);
});

test('플러그인(.js) 파일 창에서 "Dusk Atelier 최신판 넣기"를 누르면 서버가 받아 넣음', async () => {
  await tap('#pickjs');
  await waitFor(`!!${ui('#dusk')}`);
  await evalOn(`${ui('#dusk')}.click()`);
  await waitFor(`document.querySelector('#picked').textContent === 'dusk_atelier.js://@name dusk_atelier'`);
  await waitFor(`!${ui('#dusk')}`);
  assert.equal(await evalOn(`!!${ui('#duskhint')}`), false); // 설치했으면 안내도 닫힘
});

test('.js가 아닌 파일 창에는 Dusk 버튼이 없음', async () => {
  await tap('#pick');
  await waitFor(`!!${ui('input[type=file]')}`);
  assert.equal(await evalOn(`!!${ui('#dusk')}`), false);
  await evalOn(`${ui('#file .x')}.click()`);
});

test('파일 내보내기: 서버에서 받은 파일을 폰에서 받을 수 있음', async () => {
  await tap('#save');
  await waitFor(`!!${ui('a[download]')}`);
  const got = await evalOn(`(async () => { const a = ${ui('a[download]')}; const r = await fetch(a.href); return { text: await r.text(), cd: r.headers.get('content-disposition'), name: a.getAttribute('download') }; })()`);
  assert.equal(got.text, '다운로드 내용');
  assert.equal(got.name, '결과.txt');
  assert.match(got.cd, /attachment/);
});

test('복사: 서버에서 복사한 글이 폰으로 옴', async () => {
  await tap('#copy');
  await waitFor(`(${ui('#clip')}?.textContent || '').includes('복사-123')`);
});

test('드래그로 순서 바꾸기: 폰에서 끌면 서버에서 실제 드래그 앤 드롭', async () => {
  // 앞 시험이 띄운 안내 상자(파일 받기 등)를 닫는다
  await evalOn(`document.querySelector('#__parlor-ui')?.shadowRoot?.getElementById('list')?.replaceChildren()`);
  const c = async (sel) => evalOn(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const a = await c('#d1');
  const b = await c('#d2');
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 6; k++) {
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y + ((b.y + 8 - a.y) * k) / 6, button: 'left', buttons: 1 });
    await new Promise((r) => setTimeout(r, 30));
  }
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y + 8, button: 'left', buttons: 0, clickCount: 1 });
  await waitFor(`document.querySelector('#dorder').textContent === 'BA'`);
});

test('서식 편집기(contenteditable)에 친 글자가 서버로 감', async () => {
  await evalOn(`document.querySelector('#ce').focus()`);
  await tab.send('Input.insertText', { text: '편집됨' });
  await waitFor(`document.querySelector('#ceout').textContent === '편집됨'`);
  await evalOn(`document.querySelector('#ce').blur()`);
});

test('우클릭 메뉴(contextmenu)가 서버로 감', async () => {
  const p = await evalOn(`(() => { const r = document.querySelector('#ctx').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await tab.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'right', clickCount: 1 });
  }
  await waitFor(`document.querySelector('#ctxout').textContent === 'ctx:1'`);
});

test('길게 누르기는 서버에서 우클릭(contextmenu)', async () => {
  const p = await evalOn(`(() => { const r = document.querySelector('#ctx').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; })()`);
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  try {
    await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await new Promise((r) => setTimeout(r, 800));
    await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitFor(`document.querySelector('#ctxout').textContent === 'ctx:2'`);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await evalOn(`document.querySelector('#ctxout').textContent`), 'ctx:2'); // 한 번만
  } finally {
    await tab.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
});

test('새 창(window.open)은 폰에서 열 수 있는 링크로 옴', async () => {
  await tap('#win');
  await waitFor(`(${ui('a[target=_blank]')}?.href || '').endsWith('/newpage')`);
});

test('알림(Notification)이 폰 안내 화면에 뜸', async () => {
  await tap('#noti');
  await waitFor(`(document.querySelector('#__parlor-ui')?.shadowRoot?.textContent || '').includes('응답 도착')`);
});

test('안내 상자는 화면 아래(채팅 입력줄 자리)를 가리지 않음', async () => {
  // 알림 시험에서 띄운 상자가 남아 있는 상태
  await waitFor(`(document.querySelector('#__parlor-ui')?.shadowRoot?.getElementById('list')?.children.length || 0) > 0`);
  assert.notEqual(await evalOn(`document.elementFromPoint(innerWidth / 2, innerHeight - 20)?.id`), '__parlor-ui');
});

test('소리와 TTS는 폰에서 재생하도록 전달됨', async () => {
  await tap('#snd');
  await waitFor(`(window.__parlorLog || []).some((o) => o.op === 'media' && o.action === 'play' && o.src.endsWith('/beep.wav'))`);
  await waitFor(`(window.__parlorLog || []).some((o) => o.op === 'speak' && o.text === '안녕하세요')`);
});

test('캔버스에 그린 그림이 폰에 보임', async () => {
  await tap('#draw');
  await waitFor(`(() => { const c = document.querySelector('#cv'); const d = c.getContext('2d').getImageData(20, 10, 1, 1).data; return d[0] > 200 && d[1] < 60 && d[3] > 200; })()`);
});

// 서버 페이지가 ms 동안 얼마나 길게 멈추는지(가장 긴 틈)
const maxStall = (ms) => mirror.evaluate(`new Promise((ok) => { let last = performance.now(), max = 0; const t = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; }, 20); setTimeout(() => { clearInterval(t); ok(Math.round(max)); }, ${ms}); })`);

test('그대로 있는 큰 캔버스는 다시 이미지로 만들지 않음(서버 화면이 멈추지 않음)', async () => {
  // 리수·플러그인 화면처럼 큰 캔버스 여러 개를 한 번만 그려 둔다
  await mirror.evaluate(`(() => { const box = document.createElement('div'); box.id = 'bigbox'; for (let k = 0; k < 4; k++) { const c = document.createElement('canvas'); c.width = c.height = 1600; c.style.cssText = 'width:40px;height:40px'; const g = c.getContext('2d'); const im = g.createImageData(1600, 1600); for (let j = 0; j < im.data.length; j++) im.data[j] = (j * 2654435761) >>> 24; g.putImageData(im, 0, 0); box.appendChild(c); } document.body.appendChild(box); })()`);
  await new Promise((r) => setTimeout(r, 1500)); // 처음 한 번은 보내도 된다
  const stall = await maxStall(3000);
  assert.ok(stall < 250, `서버 화면이 ${stall}ms 멈춤`);
});

test('큰 캔버스가 계속 움직여도 누르기가 빨리 반영됨', async () => {
  await mirror.evaluate(`(() => { document.getElementById('bigbox')?.remove(); const c = document.createElement('canvas'); c.id = 'anim'; c.width = c.height = 1600; c.style.cssText = 'width:40px;height:40px'; document.body.appendChild(c); const g = c.getContext('2d'); let k = 0; window.__anim = setInterval(() => { g.fillStyle = 'hsl(' + (k++ % 360) + ',80%,50%)'; g.fillRect(0, 0, 1600, 1600); for (let j = 0; j < 400; j++) g.fillRect((j * 37 + k) % 1600, (j * 91) % 1600, 30, 30); }, 30); })()`);
  await new Promise((r) => setTimeout(r, 1000));
  const times = [];
  for (let n = 0; n < 4; n++) {
    const before = await mirror.evaluate(`document.querySelector('#b').textContent`);
    const t0 = Date.now();
    await tap('#b');
    await waitFor(`document.querySelector('#b').textContent !== ${JSON.stringify(before)}`);
    times.push(Date.now() - t0);
  }
  await mirror.evaluate(`clearInterval(window.__anim); document.getElementById('anim').remove()`);
  const avg = times.reduce((a, b) => a + b) / times.length;
  assert.ok(avg < 800, `누르기 평균 ${Math.round(avg)}ms (${times.join(', ')})`);
});

test('상태 페이지: 보낸 양·입력 처리 시간·메모리를 보여 줌', async () => {
  const st = await evalOn(`fetch('/__parlor/stats').then((r) => r.json())`);
  assert.ok(st['최근 입력(기다림·처리 ms)'].length > 0);
  assert.match(st['서버 리수 JS 메모리'], /MB$/);
  assert.equal(typeof st['종류별'], 'object');
});

test('호버: 폰에서 마우스를 올리면 서버에서도 올라감', async () => {
  const p = await evalOn(`(() => { const r = document.querySelector('#hov').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; })()`);
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x - 200, y: p.y + 300 });
  await new Promise((r) => setTimeout(r, 100));
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await waitFor(`document.querySelector('#hovout').textContent === 'hov:1'`);
});

test('클립보드 읽기: 서버 앱의 readText()에 폰에서 붙여넣은 내용이 감', async () => {
  await tap('#paste');
  await waitFor(`!!${ui('textarea')}`);
  await evalOn(`(() => { const t = ${ui('textarea')}; t.value = '붙임-1'; ${ui('button.send')}.click(); })()`);
  await waitFor(`document.querySelector('#pasted').textContent === '붙임-1'`);
});


test('미러는 리수 비밀번호를 물어보고, 맞으면 기억함', async () => {
  const base = `http://127.0.0.1:${mirror.port}`;
  // 로그인 전: 미러 화면 대신 비밀번호 화면, 미러 기능은 401
  assert.match(await (await fetch(base + '/__parlor/')).text(), /id="pw"/);
  assert.equal((await fetch(base + '/__parlor/stream')).status, 401);
  // 틀린 비밀번호
  const bad = await fetch(base + '/__parlor/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  await new Promise((r) => setTimeout(r, 1100));
  // 맞는 비밀번호 → 쿠키로 기억
  const cookie = await loginCookie();
  assert.match(await (await fetch(base + '/__parlor/', { headers: { cookie } })).text(), /mirror\.js/);
});

test('/__parlor 밖의 주소는 리수로 그대로 넘어감(POST 본문 포함), 로그인 안 한 사람에겐 서버 쿠키를 안 붙임', async () => {
  const base = `http://127.0.0.1:${mirror.port}`;
  const r = await (await fetch(base + '/echo', { method: 'POST', body: 'hello', headers: { cookie: 'mine=1' } })).json();
  assert.deepEqual(r, { m: 'POST', b: 'hello', cookie: 'mine=1' });
  // 리스바드 HttpOnly 세션 쿠키로 지킨 파일: 그냥 들어오면 막히고, 미러 로그인한 기기는 서버 Chrome 쿠키로 받음
  assert.equal((await fetch(base + '/secure.png')).status, 401);
  assert.equal((await fetch(base + '/secure.png', { headers: { cookie: await loginCookie() } })).status, 200);
});

test('웹소켓(Upgrade) 요청도 리수로 이어 줌', async () => {
  const sock = net.connect(mirror.port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  let got = '';
  sock.on('data', (d) => { got += d; if (got.includes('\r\n\r\n') && !got.includes('ping')) sock.write('ping'); });
  const end = Date.now() + 5000;
  while (!got.endsWith('ping') && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
  sock.destroy();
  assert.match(got, /^HTTP\/1\.1 101/);
  assert.ok(got.endsWith('ping'));
});

test('다른 폰이 접속하면 이전 폰은 멈추고, "여기서 다시 열기"로 되찾음', async () => {
  // 두 번째 폰(같은 Chrome의 새 탭)
  const tab2 = await openPage(phoneCdp);
  const { targetId } = tab2;
  const ev2 = async (expr) => (await tab2.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const wait2 = async (expr, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await ev2(expr)) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error('시간 초과(폰2): ' + expr);
  };
  const kicked = `!!document.querySelector('#__parlor-ui')?.shadowRoot?.querySelector('#kicked')`;
  try {
    await tab2.send('Page.navigate', { url: `http://127.0.0.1:${mirror.port}/__parlor/` });
    await wait2(`!!document.querySelector('#b')`);
    // 이전 폰은 멈춤 안내가 뜨고, 자동 재연결로 다시 빼앗지 않음
    await waitFor(kicked);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await ev2(kicked), false);
    // 이전 폰의 입력은 서버가 받지 않음
    const before = await mirror.evaluate(`document.querySelector('#b').textContent`);
    const st = await evalOn(`fetch('/__parlor/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: 'click', id: 1 }) }).then((r) => r.status)`);
    assert.equal(st, 409);
    // 새 폰은 정상 동작
    const n = Number(before.split(':')[1]);
    const p = await ev2(`(() => { const r = document.querySelector('#b').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await tab2.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await wait2(`document.querySelector('#b').textContent === 'count:${n + 1}'`);
    // 이전 폰에서 "여기서 다시 열기" → 되찾고, 새 폰이 멈춤
    await evalOn(`document.querySelector('#__parlor-ui').shadowRoot.querySelector('#kicked button').click()`);
    await waitFor(`!!document.querySelector('#b') && !(${kicked})`);
    await wait2(kicked);
    await tap('#b');
    await waitFor(`document.querySelector('#b').textContent === 'count:${n + 2}'`);
  } finally {
    await phoneCdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
});

test('nginx 같은 앞단 서버가 화면 스트림을 모아 두지 않도록 알림', async () => {
  // nginx는 X-Accel-Buffering: no를 보면 그 응답만 버퍼링을 끈다(설정 파일을 안 고쳐도 됨).
  // no-transform은 앞단 서버가 압축하느라 스트림을 붙잡지 않게 한다.
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${mirror.port}/__parlor/stream`, { signal: ac.signal, headers: { 'x-forwarded-for': '1.2.3.4', cookie: await loginCookie() } });
  try {
    assert.equal(r.headers.get('x-accel-buffering'), 'no');
    assert.match(r.headers.get('cache-control') || '', /no-transform/);
  } finally {
    ac.abort();
  }
});
