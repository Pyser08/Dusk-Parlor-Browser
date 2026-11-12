// 리수 원본을 최대한 '실제 코드'로 쓰고, 화면·네트워크·저장 계층만 자동으로 빈 모듈로 바꾼다.
import path from 'node:path'
import fs from 'node:fs'
const SRC = '/home/claude/risu-src/src'
const NM = '/home/claude/risu-src/node_modules'
// 실제 코드로 쓸 리수 파일 (프롬프트 조립에 관여)
const REAL = new Set([
  'ts/process/index.svelte.ts', 'ts/process/lorebook.svelte.ts', 'ts/process/scripts.ts',
  'ts/process/exampleMessages.ts', 'ts/process/prompt.ts', 'ts/parser/chatML.ts',
  'ts/parser/parser.svelte.ts', 'ts/parser/chatVar.svelte.ts', 'ts/cbs.ts', 'ts/process/infunctions.ts',
  'ts/model/types.ts', 'ts/process/group.ts', 'ts/util.ts', 'ts/storage/database.svelte.ts', 'ts/storage/defaultPrompts.ts', 'ts/process/templates/templates.ts',
])
// 손으로 쓴 대체 모듈
const MANUAL = JSON.parse(fs.readFileSync('./manual.json', 'utf8'))
const stubSrc = new Map()
const autoStubbed = new Set()

// 가져가는 쪽 소스에서 이름을 읽어 같은 이름의 빈 export를 만든다
function autoStub(spec, importer) {
  const src = fs.readFileSync(importer, 'utf8')
  const names = new Set(); let hasDefault = false
  const re = new RegExp(`import\\s+((?:(?!\\bimport\\b)[^;])*?)\\s+from\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]`, 'g')
  for (const m of src.matchAll(re)) {
    let clause = m[1].replace(/^type\s+/, '')
    const named = clause.match(/\{([^}]*)\}/)
    if (named) for (const n of named[1].split(',')) { const t = n.trim(); if (t && !t.startsWith('type ')) names.add(t.split(/\s+as\s+/)[0].trim()) }
    const def = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim()
    if (def && !def.startsWith('*')) hasDefault = true
    if (def.startsWith('*')) hasDefault = true
  }
  return { names, hasDefault }
}
const noop = 'new Proxy(function(){}, { get: (t, k) => k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : NOOP, apply: () => undefined })'

await Bun.build({
  entrypoints: ['./entry.ts'], outdir: './out', target: 'browser', format: 'iife',
  banner: 'var safeStructuredClone = function(x){ var s = (typeof x === \"function\") ? undefined : JSON.stringify(x); return s === undefined ? x : JSON.parse(s) }; var $effect = Object.assign(function(){}, { root: function(f){ f() } }); var $state = function(v){ return v }; $state.raw = function(v){ return v }; $state.snapshot = function(v){ return v }; var $derived = function(v){ return v };',
  plugins: [{ name: 'stub', setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.path === './entry.ts') return
      if (/\.css$/.test(a.path)) return { path: 'empty:', namespace: 'stub' }
      // 순수 로직 외부 라이브러리는 실제 소스를 쓴다
      if (a.path === '@risuai/ccardlib') return { path: '/home/claude/ccardlib/src/index.ts' }
      if (a.importer.startsWith('/home/claude/ccardlib/')) return { path: path.resolve(path.dirname(a.importer), a.path.replace(/\.js$/, fs.existsSync(path.resolve(path.dirname(a.importer), a.path)) ? '.js' : '.ts')) }
      let p = a.path.replace(/^src\//, SRC + '/')
      if (p.startsWith('.')) p = path.resolve(path.dirname(a.importer), p)
      const rel = p.startsWith(SRC) ? p.replace(SRC + '/', '').replace(/\.(ts|js)$/, '') : null
      const manualKey = Object.keys(MANUAL).find(k => a.path === k || (rel && rel === k))
      if (manualKey) {
        // 손으로 쓴 모듈에 없는 이름은 빈 export로 보충
        const key = 'manual:' + manualKey + '@' + a.importer
        const base = MANUAL[manualKey]
        const have = new Set([...base.matchAll(/export\s+(?:const|let|var|function|class|async function)\s+([\w$]+)/g)].map(m => m[1]))
        for (const m of base.matchAll(/export\s+const\s+([^;=]+?=[^;]*?)(?:;|$)/gm)) for (const part of m[1].split(',')) { const n = part.split('=')[0].trim(); if (/^[\w$]+$/.test(n)) have.add(n) }
        for (const m of base.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) have.add(n.trim().split(/\s+as\s+/).pop())
        const { names, hasDefault } = autoStub(a.path, a.importer)
        const extra = [...names].filter(n => !have.has(n))
        stubSrc.set(key, base + `\nconst NOOP = ${noop}; ` + extra.map(n => `export const ${n} = NOOP;`).join(' ') + (hasDefault && !/export default/.test(base) ? ' export default NOOP;' : ''))
        return { path: key, namespace: 'stub' }
      }
      if (rel && REAL.has(rel + '.ts')) return { path: SRC + '/' + rel + '.ts' }
      const key = 'auto:' + a.path + '@' + a.importer
      const { names, hasDefault } = autoStub(a.path, a.importer)
      autoStubbed.add(a.path)
      stubSrc.set(key, `const NOOP = ${noop}; ${[...names].map(n => `export const ${n} = NOOP;`).join(' ')} ${hasDefault ? 'export default NOOP;' : ''}`)
      return { path: key, namespace: 'stub' }
    })
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
      if (a.path === 'empty:') return { contents: '', loader: 'js' }
            return { contents: stubSrc.get(a.path), loader: 'js' }
    })
  }}],
}).then(r => {
  if (!r.success) { console.log(r.logs.join('\n')); process.exit(1) }
  console.log('built. 자동으로 빈 모듈 처리한 의존성', autoStubbed.size, '개:\n ', [...autoStubbed].sort().join('\n  '))
})
