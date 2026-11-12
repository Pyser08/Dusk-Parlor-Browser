import WebKit

/// 입력창(textarea) 초안을 네이티브에 백업해 두고,
/// 웹 프로세스가 죽었다 살아나면 다시 채워 넣는다.
final class DraftBridge: NSObject, WKScriptMessageHandler {
    var siteID = ""
    private var key: String { "dusk.draft.\(siteID)" }

    func install(into ucc: WKUserContentController) {
        ucc.add(WeakHandler(self), name: "duskDraft")
        let saved = UserDefaults.standard.string(forKey: key) ?? ""
        let savedJSON = (try? String(data: JSONEncoder().encode(saved), encoding: .utf8)) ?? "\"\""
        let js = """
        (() => {
          const saved = \(savedJSON);
          let t = 0;
          document.addEventListener('input', (e) => {
            const el = e.target;
            if (!(el instanceof HTMLTextAreaElement)) return;
            clearTimeout(t);
            t = setTimeout(() => window.webkit.messageHandlers.duskDraft.postMessage(el.value), 400);
          }, true);
          if (!saved) return;
          // 리수 입력창이 그려질 때까지 기다렸다가 한 번만 복원
          const obs = new MutationObserver(() => {
            const ta = document.querySelector('textarea');
            if (!ta || ta.value) return;
            ta.value = saved;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            obs.disconnect();
          });
          obs.observe(document.documentElement, { childList: true, subtree: true });
          setTimeout(() => obs.disconnect(), 15000);
        })();
        """
        ucc.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String, text.utf8.count < 200_000 else { return }
        UserDefaults.standard.set(text, forKey: key)
    }
}

/// WKUserContentController가 핸들러를 강하게 붙잡아 생기는 순환 참조 방지
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
