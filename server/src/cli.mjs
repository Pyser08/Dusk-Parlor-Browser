import { startMirror } from './mirror-server.mjs';
import { startFallback } from './fallback.mjs';

const target = process.env.PARLOR_TARGET;
if (!target) {
  console.error('PARLOR_TARGET에 리수 주소를 넣어 주세요. 예) PARLOR_TARGET=http://127.0.0.1:6001 npm start');
  process.exit(1);
}

// pm2가 리스와 미러를 동시에 켜면(재부팅 등) 리스가 아직 안 떠 있을 수 있다 → 응답할 때까지 기다린다
for (let i = 0; ; i++) {
  const ok = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
  if (ok) break;
  if (i === 0) console.log(`[parlor] 리스(${target}) 기다리는 중…`);
  await new Promise((r) => setTimeout(r, 1000));
}

const opts = {
  target,
  port: Number(process.env.PARLOR_PORT || 7300),
  host: process.env.PARLOR_HOST || '0.0.0.0',
  chromeBin: process.env.CHROME_BIN,
  // Dusk Atelier 안내·설치 버튼(PARLOR_DUSK=0이면 끔)
  dusk: process.env.PARLOR_DUSK === '0' ? null : { url: process.env.PARLOR_DUSK_URL || 'https://github.com/Pyser08/Dusk-Atelier/releases/latest/download/dusk_atelier.js' },
  userDataDir: process.env.PARLOR_PROFILE || new URL('../.parlor-profile', import.meta.url).pathname,
};

// 미러를 켜지 못하면(Chrome이 안 뜨는 등) 리스로 넘기기만 하는 대체 서버로 포트를 지키고 1분마다 다시 시도한다.
// 이 포트가 원래 리스 포트이므로, 그냥 죽으면 리스까지 끊긴다.
let m = null, fb = null;
for (;;) {
  try {
    if (fb) { await fb.close(); fb = null; }
    m = await startMirror(opts);
    break;
  } catch (e) {
    console.error('[parlor] 미러를 켜지 못했어요(리스는 그대로 넘겨요, 1분 뒤 다시 시도):', e?.message || e);
    if (!fb) fb = await startFallback({ ...opts, reason: e?.message || e }).catch((e2) => { console.error('[parlor] 대체 서버도 못 켰어요:', e2.message); return null; });
    await new Promise((r) => setTimeout(r, 60000));
  }
}
console.log(`[parlor] ${target} 미러 중 → http://<서버>:${m.port}/__parlor/`);

const stop = async () => { await m.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
