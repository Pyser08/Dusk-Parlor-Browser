// 같은 번들을 '전역이 다 있는 일반 Node'에서 돌려, 샌드박스(JSC 흉내) 결과와 같은지 비교
import fs from 'node:fs'
globalThis.window = globalThis; globalThis.document = {}
const V = new Proxy({}, { get: (_, k) => typeof k !== 'string' ? 'null' : k.startsWith('$') ? k.slice(1) : k.startsWith('toggle_') ? k.slice(7) : 'null' })
globalThis.__risu = { selId: 0, db: { characters: [{ chatPage: 0, chats: [{ scriptstate: V }], defaultVariables: '' }], globalChatVariables: V, templateDefaultVariables: '', username: 'Pyser' } }
;(0, eval)(fs.readFileSync('out/entry.js', 'utf8'))
const p = (s) => RisuCore.risuChatParser(s)
for (const s of ['0 {{#when::var::true}}CBS{{/}} 9', '0 {{#when::toggle::true}}CBS{{/}} 9', '{{cbr::3}}'])
  console.log(JSON.stringify(s), '→', JSON.stringify(RisuCore.risuUnescape(p(s))))
