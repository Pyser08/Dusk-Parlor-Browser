import { startMirror } from './mirror-server.mjs';

const target = process.env.PARLOR_TARGET;
if (!target) {
  console.error('PARLOR_TARGET에 리수 주소를 넣어 주세요. 예) PARLOR_TARGET=http://127.0.0.1:6001 npm start');
  process.exit(1);
}

const m = await startMirror({
  target,
  port: Number(process.env.PARLOR_PORT || 7300),
  host: process.env.PARLOR_HOST || '0.0.0.0',
  chromeBin: process.env.CHROME_BIN,
  userDataDir: process.env.PARLOR_PROFILE || new URL('../.parlor-profile', import.meta.url).pathname,
});
console.log(`[parlor] ${target} 미러 중 → http://<서버>:${m.port}/__parlor/`);

const stop = async () => { await m.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
