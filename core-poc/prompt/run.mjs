// JSC 흉내 샌드박스에서 리수 원본 sendChat을 돌려, 전송 직전 프롬프트를 가로챈다
import vm from 'node:vm'
import fs from 'node:fs'
const sandbox = process.argv[2] !== 'full'
const ctx = sandbox ? vm.createContext({ console }) : globalThis
const run = (c) => sandbox ? vm.runInContext(c, ctx) : (0, eval)(c)
if (!sandbox) { globalThis.window = globalThis; globalThis.document = { createElement: () => ({}) } }
run(fs.readFileSync('host-polyfills.js', 'utf8'))
run(`globalThis.__risu = { selId: 0, db: {} }`)
run(fs.readFileSync('out/entry.js', 'utf8'))
run(String.raw`
const db = {
  hypaV3Presets: [], username: 'Pyser', personaPrompt: '{{user}}는 탐정 사무소의 조수다.',
  characters: [{
    type: 'character', chaId: 'c1', name: '세라', desc: '{{char}}는 은빛 궁전의 사서다. 말끝마다 "~랍니다"를 붙인다.',
    personality: '차분함', scenario: '비 오는 밤의 도서관', firstMessage: '어서 오세요, {{user}}.',
    exampleMessage: '<START>\n{{user}}: 책 있어?\n{{char}}: 물론 있답니다.',
    chatPage: 0, chats: [{ name: 'c', fmIndex: -1, localLore: [], note: '작가 노트: 긴장감 유지', message: [
      { role: 'user', data: '금서고에 가고 싶어. 오늘은 {{calc::2+3}}번째 방문이야.' },
      { role: 'char', data: '금서고라면 열쇠가 필요하답니다.' },
      { role: 'user', data: '은빛 열쇠에 대해 알려줘' },
    ] }],
    globalLore: [
      { key: '은빛 열쇠', comment: '열쇠', content: '[로어북] 은빛 열쇠는 금서고를 여는 유일한 열쇠다.', mode: 'normal', insertorder: 100, alwaysActive: false, secondkey: '', selective: false },
      { key: '용', comment: '무관', content: '[로어북] 이건 나오면 안 됨', mode: 'normal', insertorder: 100, alwaysActive: false, secondkey: '', selective: false },
    ],
    customscript: [ { comment: '정규식', in: '금서고', out: '禁書庫', type: 'editprocess', flag: 'g', ableFlag: true } ],
    bias: [], viewScreen: 'none', utilityBot: false, sdData: [], emotionImages: [], additionalAssets: [], firstMsgIndex: -1,
    postHistoryInstructions: '', systemPrompt: '', alternateGreetings: [], tags: [], creator: '', characterVersion: '', triggerscript: [],
    replaceGlobalNote: '', depth_prompt: { depth: 0, prompt: '' }, defaultVariables: '', loreSettings: undefined, lowLevelAccess: false,
  }],
}
RisuCore.setDatabase(db); globalThis.__risu.db = db
`)
const t0 = Date.now()
try {
  const ok = await run(`RisuCore.sendChat(-1, {})`)
  console.log('sendChat 반환:', ok, `(${Date.now() - t0}ms)`)
} catch (e) { console.log('실패:', e.stack.split('\n').slice(0, 8).join('\n')) }
const alerts = run('globalThis.__alerts ?? []'); if (alerts.length) console.log('경고:', alerts)
const cap = run('globalThis.__captured ?? []')
console.log('가로챈 요청 수:', cap.length, '| 호스트가 채운 API:', run('__hostPolyfills').join(', ') || '없음')
if (cap[0]) {
  const out = cap[0].formated.map(m => `[${m.role}] ${m.content}`).join('\n---\n')
  fs.writeFileSync(sandbox ? 'prompt.sandbox.txt' : 'prompt.full.txt', out)
  console.log(out)
}
