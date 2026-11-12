// 실제 리수 요청 로그 vs 우리 코어(샌드박스)가 만든 프롬프트를 메시지 단위로 대조
import vm from 'node:vm'
import fs from 'node:fs'
const card = JSON.parse(fs.readFileSync('charx/card.json', 'utf8')).data
const mod = JSON.parse(fs.readFileSync('module.json', 'utf8'))
const log = JSON.parse(fs.readFileSync('log_messages.json', 'utf8'))
const extraVars = JSON.parse(process.argv[2] || '{}') // 그대 채팅의 변수 상태 추정치

const ctx = vm.createContext({ console: { log(){}, error(){}, warn(){} } })
const run = (c) => vm.runInContext(c, ctx)
run(fs.readFileSync('../prompt/host-polyfills.js', 'utf8'))
run(`globalThis.__risu = { selId: 0, db: {} }`)
run(fs.readFileSync('../prompt/out/entry.js', 'utf8'))
const r = card.extensions.risuai
// importCharacterCardSpec의 필드 대응 그대로 (charx: 모듈의 로어북·정규식·트리거를 캐릭터에)
const char = {
  type: 'character', name: card.name, firstMessage: card.first_mes, desc: card.description, notes: '',
  chats: [{ message: [...(process.env.FM_IN_CHAT ? [{ role: 'char', data: card.first_mes }] : []), { role: 'user', data: '차분히 인사하고 자신의 정보를 말해준다.' }], note: '', name: 'Chat 1', localLore: [], fmIndex: -1,
            scriptstate: Object.fromEntries(Object.entries(extraVars).map(([k, v]) => ['$' + k, String(v)])) }],
  chatPage: 0, emotionImages: [], bias: r.bias ?? [], globalLore: mod.lorebook, viewScreen: r.viewScreen ?? 'none', chaId: 'ah',
  sdData: [], utilityBot: false, customscript: mod.regex, exampleMessage: card.mes_example ?? '', creatorNotes: card.creator_notes,
  systemPrompt: card.system_prompt ?? '', postHistoryInstructions: '', alternateGreetings: card.alternate_greetings ?? [], tags: [],
  creator: card.creator, characterVersion: card.character_version, personality: card.personality ?? '', scenario: card.scenario ?? '',
  firstMsgIndex: -1, removedQuotes: false, loreSettings: { tokenBudget: card.character_book.token_budget, scanDepth: card.character_book.scan_depth, recursiveScanning: card.character_book.recursive_scanning, fullWordMatching: false },
  loreExt: card.character_book.extensions, additionalAssets: [], replaceGlobalNote: card.post_history_instructions ?? '',
  triggerscript: mod.trigger, additionalText: r.additionalText ?? '', lorePlus: r.lorePlus ?? false, defaultVariables: r.defaultVariables ?? '',
  lowLevelAccess: false, depth_prompt: card.extensions.depth_prompt ?? { depth: 0, prompt: '' }, prebuiltAssetCommand: r.prebuiltAssetCommand,
}
ctx.__char = JSON.parse(JSON.stringify(char))
run(`const db = { hypaV3Presets: [], username: '미오', characters: [__char] }; RisuCore.setDatabase(db); db.maxContext = 200000; db.maxResponse = 12000; globalThis.__risu.db = db`)
const t0 = Date.now()
try { await run('RisuCore.sendChat(-1, {})') } catch (e) { console.log('sendChat 예외:', e.stack.split('\n').slice(0,6).join(' | ')) }
const ms = Date.now() - t0; console.log('경고:', JSON.stringify(run('globalThis.__alerts ?? []')).slice(0,300))
const ours = (run('globalThis.__captured ?? []')[0]?.formated ?? []).map(m => ({ role: m.role, content: m.content }))
fs.writeFileSync('ours.json', JSON.stringify(ours, null, 1))

// 대조: 로그 메시지마다 우리 출력에 같은 내용이 있는지
const norm = (s) => String(s).replace(/\r\n/g, '\n').trim()
const oursSet = new Map(ours.map((m, i) => [norm(m.content), i]))
let exact = 0, rows = []
for (const [i, m] of log.entries()) {
  const k = norm(m.content); const hit = oursSet.has(k)
  if (hit) exact++
  rows.push(`${hit ? '일치' : '  - '} #${i} [${m.role}] ${k.slice(0, 50).replace(/\n/g, ' ')}`)
}
console.log(rows.join('\n'))
console.log(`\n로그 ${log.length}개 중 우리 출력과 내용이 똑같은 메시지 ${exact}개 | 우리 출력 ${ours.length}개 | ${ms}ms`)
