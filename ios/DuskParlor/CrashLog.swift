import WebKit

/// 페이지의 console.error/warn, 잡히지 않은 오류, 플러그인 관련 흔적을 네이티브 링버퍼에 모아 두고,
/// 웹 프로세스가 죽으면 '파일' 앱(Dusk Parlor Browser 폴더 > crashlogs)에 남긴다.
/// 웹 프로세스는 죽는 순간 아무것도 못 남기므로, 로그는 평소에 네이티브로 미리 보내 둔다.
final class CrashLog: NSObject, WKScriptMessageHandler {
    var siteID = ""
    private var ring: [String] = []
    private let limit = 300
    private var lastURL = ""

    func install(into ucc: WKUserContentController) {
        ucc.add(WeakHandler(self), name: "duskLog")
        let js = """
        (() => {
          const post = (lv, args) => {
            try {
              const s = args.map(a => {
                if (a instanceof Error) return a.stack || a.message;
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a).slice(0, 500); } catch { return String(a); }
              }).join(' ').slice(0, 2000);
              window.webkit.messageHandlers.duskLog.postMessage(lv + ' ' + s);
            } catch {}
          };
          for (const lv of ['error', 'warn']) {
            const orig = console[lv].bind(console);
            console[lv] = (...a) => { post(lv.toUpperCase(), a); orig(...a); };
          }
          window.addEventListener('error', e =>
            post('UNCAUGHT', [e.message, (e.filename || '') + ':' + e.lineno, e.error]), true);
          window.addEventListener('unhandledrejection', e => post('REJECT', [e.reason]));
          // 무거운 작업 흔적: 200ms 넘게 메인 스레드를 막은 작업
          try {
            new PerformanceObserver(l => l.getEntries().forEach(en => {
              if (en.duration > 200) post('LONGTASK', [Math.round(en.duration) + 'ms']);
            })).observe({ type: 'longtask', buffered: true });
          } catch {}
          post('PAGE', [location.href]);
        })();
        """
        // 플러그인 iframe에서도 잡히도록 모든 프레임에 주입
        ucc.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let s = message.body as? String else { return }
        let frame = message.frameInfo.isMainFrame ? "main" : "frame:\(message.frameInfo.securityOrigin.host)"
        ring.append("\(Self.stamp()) [\(frame)] \(s)")
        if ring.count > limit { ring.removeFirst(ring.count - limit) }
    }

    func note(_ line: String) {
        ring.append("\(Self.stamp()) [native] \(line)")
    }

    /// 웹 프로세스 종료 시 호출. 저장한 파일 경로를 돌려준다.
    @discardableResult
    func dump(reason: String) -> URL? {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("crashlogs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = "\(siteID)-\(Self.fileStamp()).txt"
        let url = dir.appendingPathComponent(name)
        let header = """
        reason: \(reason)
        site: \(siteID)
        app memory: \(MemoryHUD.footprint() / 1_048_576)MB
        ---

        """
        try? (header + ring.joined(separator: "\n")).write(to: url, atomically: true, encoding: .utf8)
        ring.removeAll()
        Self.prune(dir)
        return url
    }

    /// 최근 20개만 보관
    private static func prune(_ dir: URL) {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.creationDateKey])) ?? []
        let sorted = files.sorted {
            let a = (try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            let b = (try? $1.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            return a > b
        }
        sorted.dropFirst(20).forEach { try? FileManager.default.removeItem(at: $0) }
    }

    private static func stamp() -> String {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f.string(from: Date())
    }
    private static func fileStamp() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"; return f.string(from: Date())
    }
}
