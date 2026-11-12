// 호스트(네이티브 앱)가 globalThis.__risu 에 db·selId를 넣어 준다는 가정의 가짜 모듈들
const R = () => globalThis.__risu
const store = (getv) => ({ subscribe(fn){ fn(getv()); return () => {} }, set(){}, update(){} })
export const stubs = {
  'svelte/store': `
    export function get(s){ let v; s.subscribe(x=>v=x)(); return v }
    export function writable(v){ let subs=[]; return { subscribe(f){ f(v); subs.push(f); return ()=>{} }, set(n){ v=n; subs.forEach(f=>f(v)) }, update(fn){ this.set(fn(v)) } } }`,
  'stores.svelte': `
    const R = () => globalThis.__risu
    export const DBState = { get db(){ return R().db } }
    export const selIdState = { get selId(){ return R().selId } }
    export const selectedCharID = { subscribe(f){ f(R().selId); return ()=>{} } }
    export const CurrentTriggerIdStore = { subscribe(f){ f(null); return ()=>{} } }
    export const CharEmotion = { subscribe(f){ f({}); return ()=>{} } }`,
  'storage/database.svelte': `
    const R = () => globalThis.__risu
    export const appVer = 'jsc-poc'
    export const getDatabase = () => R().db
    export const getCurrentCharacter = () => R().db.characters[R().selId]
    export const getCurrentChat = () => { const c = R().db.characters[R().selId]; return c.chats[c.chatPage] }`,
  'globalApi.svelte': `export const aiWatermarkingLawApplies = () => false; export const getFileSrc = async () => ''; export const downloadFile = async () => {}`,
  'platform': `export const isTauri = false, isNodeServer = false, isIOS = false`,
  'util': `
    const R = () => globalThis.__risu
    export function findCharacterbyId(id){ for(const c of R().db.characters){ if(c.type!=='group' && c.chaId===id) return c } return { name:'Unknown Character' } }
    export const getPersonaPrompt = () => R().db.personaPrompt ?? ''
    export const getUserIcon = () => ''
    export const getUserName = () => R().db.username ?? 'User'
    function sfc32(a,b,c,d){ return function(){ a|=0;b|=0;c|=0;d|=0; let t=(a+b|0)+d|0; d=d+1|0; a=b^b>>>9; b=c+(c<<3)|0; c=(c<<21|c>>>11); c=c+t|0; return (t>>>0)/4294967296 } }
    export function pickHashRand(cid,word){ let h=5515; const r=w=>{ for(let i=0;i<w.length;i++) h=((h<<5)+h)+w.charCodeAt(i); return h }; const f=sfc32(r(word),r(word),r(word),r(word)); for(let i=0;i<cid%1000;i++) f(); return f() }
    export async function replaceAsync(s,re,fn){ const rs=await Promise.all(Array.from(s.matchAll(re),m=>fn(...m))); let i=0; return s.replace(re,()=>rs[i++]) }
    export function parseKeyValue(t){ if(!t) return []; const o=[]; for(const l of t.split('\\n')){ const [k,v]=l.split('='); if(k&&v) o.push([k,v]) } return o }`,
  'process/scripts': `export const processScriptFull = async (c,d) => ({ data:d, emoChanged:false, cbsConditions:{} })`,
  'process/files/inlays': `export const getInlayAssetBlob = async () => null`,
  'process/modules': `export const getModuleAssets = () => [], getModuleLorebooks = () => [], getModules = () => []`,
  'model/modellist': `export const getModelInfo = () => ({ id:'poc', name:'poc', flags:[], format:0 })`,
  'lang': `export const language = new Proxy({}, { get: (_, k) => String(k) })`,
  // 화면 렌더링 라이브러리: 프롬프트 처리에는 쓰이지 않으므로 빈 껍데기
  'dompurify': `export default { sanitize: s => s, addHook(){}, setConfig(){} }`,
  'markdown-it': `export default function(){ return { render: s => s, use(){ return this }, disable(){ return this } } }`,
  '@adobe/css-tools': `export default { parse: () => ({ stylesheet:{ rules:[] } }), stringify: () => '' }`,
  'highlight.js/lib/core': `export default { registerLanguage(){}, highlight: s => ({ value:s }) }`,
  'hl': 'export default () => ({})',
  'katex': `export default { renderToString: s => s }`,
  'postcss-selector-parser': `export default () => ({ processSync: s => s })`,
}
