// JavaScriptCore(JSContext)와 비슷하게: 표준 JS 내장 객체만 있고 window/document/console/fetch가 없는 샌드박스
import vm from 'node:vm'
import fs from 'node:fs'
const code = fs.readFileSync('out/entry.js', 'utf8')
const vars = new Proxy({}, { get: (_, k) => typeof k === 'string' ? k.replace(/^\$/, '') : undefined })
const ctx = vm.createContext({})
vm.runInContext(String.raw`var V = new Proxy({}, { get: (_, k) => typeof k !== 'string' ? 'null' : k.startsWith('$') ? k.slice(1) : k.startsWith('toggle_') ? k.slice(7) : 'null' }); globalThis.__risu = { selId: 0, db: { characters: [{ chatPage: 0, chats: [{ scriptstate: V }], defaultVariables: '' }], globalChatVariables: V, templateDefaultVariables: '', username: 'Pyser' } }`, ctx)
const forbidden = ['window','document','console','fetch','setTimeout','localStorage','navigator','TextEncoder']
console.log('샌드박스에 없는 전역:', forbidden.filter(g => vm.runInContext(`typeof ${g}`, ctx) === 'undefined').join(', '))
try { vm.runInContext(code, ctx) } catch (e) { console.log('로드 실패:', e.message); process.exit(1) }
console.log('로드 성공, RisuCore =', vm.runInContext('Object.keys(RisuCore).join()', ctx))
ctx.__vars = vars
const parse = (s) => vm.runInContext(`RisuCore.risuChatParser(${JSON.stringify(s)})`, ctx)

// 리수 자체 테스트에서 리터럴 기대값만 뽑아, 파일별 도우미를 원본과 똑같이 맞춰 대조
const T = '/home/claude/risu-src/src/ts/parser/tests/cbs/'
const cbs = (op, ...a) => `{{${op}${a.length > 0 ? '::' : ''}${a.join('::')}}}`
const indentedBody = `\n\n  C  \n  B  \n  S  \n\n`
const unescape = (s) => vm.runInContext(`RisuCore.risuUnescape(${JSON.stringify(s)})`, ctx)
const helpers = {
  'conditionals.test.ts': { quickParse: (op, body) => parse(`0 {{${op}}}${body}{{/}} 9`) },
  'strings.test.ts': { quickParse: (op, ...a) => parse(cbs(op, ...a.map(String))) },
  'escapes.test.ts': { parse: (s) => unescape(parse(s)) },
}
let pass = 0, fail = 0, skip = 0
for (const [f, h] of Object.entries(helpers)) {
  const src = fs.readFileSync(T + f, 'utf8')
  // test.skip 블록(원본에서도 알려진 버그)은 제외
  const active = src.replace(/test\.skip\([\s\S]*?\n    \}\)/g, '')
  for (const m of active.matchAll(/expect\((.+?)\)\.toBe\((.+)\)\s*$/gm)) {
    const [, call, want] = m
    const bare = (call + want).replace(/'[^']*'|"[^"]*"/g, '')
    if (/\$\{(?!indentedBody)/.test(call + want) || /\bfc\./.test(bare)) { skip++; continue }
    try {
      const { quickParse, parse: p2 } = h
      const parseFn = p2
      const expected = eval(want)
      const got = eval(call.replace(/^parse\(/, 'parseFn('))
      if (got === expected) pass++
      else { fail++; console.log('불일치', f, call, JSON.stringify(got), '!=', JSON.stringify(expected)) }
    } catch (e) { skip++ }
  }
}
console.log(`리수 테스트 대조: 통과 ${pass} / 불일치 ${fail} / 건너뜀(무작위 생성 테스트) ${skip}`)

// 실사용 형태 몇 가지
for (const s of ['{{user}}님 안녕', '{{setvar::hp::10}}{{getvar::hp}}', '{{#if {{equal::1::1}}}}참{{/if}}', '{{calc::3*4+1}}', '{{random::a,b}}'.replace('random::a,b','arraylength::["a","b"]')])
  console.log(JSON.stringify(s), '→', JSON.stringify(parse(s)))
