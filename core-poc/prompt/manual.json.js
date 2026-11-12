const m = {}
m['svelte/store'] = `export function get(s){ let v; s.subscribe(x=>v=x)(); return v }
export function writable(v){ const subs=new Set(); return { subscribe(f){ f(v); subs.add(f); return ()=>subs.delete(f) }, set(n){ v=n; subs.forEach(f=>f(v)) }, update(fn){ this.set(fn(v)) } } }
export function derived(){ return writable(undefined) } export function readable(v){ return writable(v) }`
m['ts/stores.svelte'] = `const R = () => globalThis.__risu
function writable(v){ const subs=new Set(); return { subscribe(f){ f(v); subs.add(f); return ()=>subs.delete(f) }, set(n){ v=n; subs.forEach(f=>f(v)) }, update(fn){ this.set(fn(v)) } } }
export const DBState = { get db(){ return R().db }, set db(v){ R().db = v } }
export const selIdState = { get selId(){ return R().selId } }
export const selectedCharID = { subscribe(f){ f(R().selId); return ()=>{} }, set(){} }
const w = () => writable(null)
export const CurrentTriggerIdStore = w(), CharEmotion = writable({}), ReloadGUIPointer = writable(0), doingChat = writable(false), abortChat = writable(false)
export const CurrentChat = w(), CurrentCharacter = w(), ScrollToMessageStore = w(), chatProcessStage = writable(0), CurrentVariablePointer = w(), selectedCharIDStore = w()
export const loadedStore = writable(true), MobileGUI = writable(false), DynamicGUI = writable(false), alertStore = w(), additionalSettingsMenu = writable(false)`
m['ts/tokenizer'] = `// 근사 토크나이저 (네이티브 앱에서는 Swift 쪽 tiktoken 등으로 교체 예정)
const n = (s) => Math.ceil(String(s ?? '').length / 3)
export async function tokenize(d){ return n(d) } export async function tokenizeAccurate(d){ return n(d) }
export async function tokenizeNum(d){ return Array.from({length:n(d)}, (_, i) => i) }
export async function tokenizerChar(){ return [] }
export class ChatTokenizer { constructor(add){ this.add = add } async tokenizeChat(c){ return n(c.content) + this.add } async tokenizeChats(cs){ let t=0; for (const c of cs) t += await this.tokenizeChat(c); return t } async tokenizeMultiModal(){ return 0 } }`
m['ts/process/request/request'] = `export async function requestChatData(arg){ (globalThis.__captured ??= []).push(arg); return { type: 'success', result: '[가로챔: 실제 전송 안 함]' } }
export function applyChatTemplate(){ return '' }`
m['ts/platform'] = `export const isTauri = false, isNodeServer = false, isMobile = false; export const isIOS = () => false; export const isFirefox = false`
m['ts/globalApi.svelte'] = `export const aiWatermarkingLawApplies = () => false; export const getFileSrc = async () => ''; export const downloadFile = async () => {}; export const readImage = async () => new Uint8Array(); export const saveAsset = async () => ''; export const forageStorage = {}; export const getUnpargeables = () => []; export const loadAsset = async () => new Uint8Array(); export const globalFetch = async () => ({ ok:false, data:null }); export const AppendableBuffer = class {}; export const changeFullscreen = () => {}; export const isTauri = false; export const isNodeServer = false; export const openURL = () => {}; export const getRequestLog = () => ''; export const addFetchLog = () => 0; export const fetchNative = async () => null; export const textifyReadableStream = async () => ''; export const getFetchData = () => null; export const checkCharOrder = () => {}; export const saveDb = async () => {}; export const loadData = async () => {}; export const getModelMaxContext = () => 100000; export const mainExternalFetch = async () => null`
m['lang'] = `export const changeLanguage = () => {}; export const language = new Proxy({}, { get: (_, k) => typeof k === 'string' ? k : undefined })`
m['ts/alert'] = `export const alertError = (e) => { (globalThis.__alerts ??= []).push(String(e)) }; export const alertNormal = alertError; export const alertToast = alertError; export const alertWait = () => {}; export const alertClear = () => {}; export const alertConfirm = async () => true; export const alertInput = async () => ''; export const alertSelect = async () => '0'; export const alertMd = () => {}; export const alertStore = { subscribe(f){ f(null); return () => {} }, set(){} }`
for (const [k, v] of [['dompurify', `export default { sanitize: s => s, addHook(){}, setConfig(){}, removeHook(){} }`],
  ['markdown-it', `export default function(){ return { render: s => s, use(){ return this }, disable(){ return this } } }`],
  ['@adobe/css-tools', `export default { parse: () => ({ stylesheet:{ rules:[] } }), stringify: () => '' }`],
  ['highlight.js/lib/core', `export default { registerLanguage(){}, highlight: s => ({ value:s }) }`],
  ['katex', `export default { renderToString: s => s }`],
  ['postcss-selector-parser', `export default () => ({ processSync: s => s })`],
  ['uuid', `let i = 0; export const v4 = () => 'uuid-' + (++i)`]]) m[k] = v
require('fs').writeFileSync('manual.json', JSON.stringify(m))
const m2 = JSON.parse(require('fs').readFileSync('manual.json','utf8'))
m2['ts/model/modellist'] = `import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from '/home/claude/risu-src/src/ts/model/types.ts'
export { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer }
// 시험용 모델 하나: OpenAI 호환, 시스템 프롬프트 전체 허용
export function getModelInfo(id){ return { id: id || 'poc-model', name: 'PoC Model', internalID: 'poc', shortName: 'poc', fullName: 'PoC', provider: 0, format: LLMFormat.OpenAICompatible, flags: [LLMFlags.hasFullSystemPrompt, LLMFlags.hasPrefill], parameters: [], tokenizer: 0 } }
export const LLMModels = []`
require('fs').writeFileSync('manual.json', JSON.stringify(m2))
const m3 = JSON.parse(require('fs').readFileSync('manual.json','utf8'))
m3['ts/polyfill'] = `export function safeStructuredClone(x){ const s = (typeof x === "function") ? undefined : JSON.stringify(x); return s === undefined ? x : JSON.parse(s) }`
require('fs').writeFileSync('manual.json', JSON.stringify(m3))
const m4 = JSON.parse(require('fs').readFileSync('manual.json','utf8'))
m4['ts/sync/multiuser'] = `export let connectionOpen = false; export const peerSafeCheck = async () => true; export const peerSync = () => {}; export const peerRevertChat = () => {}`
require('fs').writeFileSync('manual.json', JSON.stringify(m4))
const m5 = JSON.parse(require('fs').readFileSync('manual.json','utf8'))
// 리수 '모듈' 시스템: 시험에서는 장착된 모듈 없음
m5['ts/process/modules'] = `export const getModules = () => [], getModuleLorebooks = () => [], getModuleAssets = () => [], getModuleRegexScripts = () => [], getModuleTriggers = () => [], getModuleToggles = () => ''`
require('fs').writeFileSync('manual.json', JSON.stringify(m5))
const m6 = JSON.parse(require('fs').readFileSync('manual.json','utf8'))
// Lua·트리거: 네이티브 Lua 엔진이 붙을 자리. 지금은 입력을 그대로 통과
m6['ts/process/scriptings'] = `export const runLuaEditTrigger = async (char, mode, data) => data; export const runLuaButtonTrigger = async () => null`
m6['ts/process/triggers'] = `export const runTrigger = async () => null`
// 플러그인 훅: 혼합형 앱에서는 기존 플러그인 미지원 → 빈 집합
m6['ts/plugins/plugins.svelte'] = `export const pluginV2 = new Proxy({}, { get: (t, k) => (t[k] ??= new Set()) })`
require('fs').writeFileSync('manual.json', JSON.stringify(m6))
