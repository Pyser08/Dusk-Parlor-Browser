// 네이티브 앱(JSContext)이 리수 코어에 넣어 줘야 하는 최소 웹 API 목록.
// 여기 추가되는 항목 = 실제 iOS 앱에서 Swift 쪽이 구현/주입해야 할 것.
globalThis.__hostPolyfills = []
const need = (name, impl) => { if (typeof globalThis[name] === 'undefined') { globalThis[name] = impl; __hostPolyfills.push(name) } }
need('AbortController', class { constructor(){ this.signal = { aborted: false, addEventListener(){}, removeEventListener(){} } } abort(){ this.signal.aborted = true } })
