import { stubs } from './stubs.js'
const SRC = '/home/claude/risu-src/src'
const REAL = ['ts/cbs.ts','ts/parser/parser.svelte.ts','ts/parser/chatVar.svelte.ts','ts/process/infunctions.ts','ts/model/types.ts']
const keyOf = (p) => {
  for (const k of Object.keys(stubs)) if (p === k || p.endsWith('/' + k) || p.endsWith('/' + k + '.ts')) return k
}
await Bun.build({
  entrypoints: ['./entry.ts'], outdir: './out', target: 'browser', format: 'iife',
  // Svelte 반응형 $effect: 네이티브 호스트에선 반응형이 없으므로 빈 함수. 에셋 캐시는 호스트가 resetAssetsCache로 직접 갱신
  banner: 'var safeStructuredClone = function(x){ return x === undefined ? x : JSON.parse(JSON.stringify(x)) }; var $effect = Object.assign(function(){}, { root: function(f){ f() } });',
  plugins: [{ name: 'stub', setup(b) {
    b.onResolve({ filter: /^highlight\.js\/lib\/languages\// }, () => ({ path: 'hl', namespace: 'stub' }))
    b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' }))
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.path === './entry.ts') return
      let p = a.path.replace(/^src\//, SRC + '/')
      if (p.startsWith('.')) p = require('path').resolve(require('path').dirname(a.importer), p)
      const k = keyOf(p)
      if (k) return { path: k, namespace: 'stub' }
      const rel = p.replace(SRC + '/', '').replace(/\.ts$/, '') + '.ts'
      if (REAL.includes(rel)) return { path: SRC + '/' + rel }
      throw new Error('예상 밖 의존성: ' + a.path + ' (from ' + a.importer + ')')
    })
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path] ?? '', loader: 'js' }))
  }}],
}).then(r => { if (!r.success) { console.log(r.logs.join('\n')); process.exit(1) } console.log('built', r.outputs[0].path) })
