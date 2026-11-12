import SwiftUI
import WebKit

struct BrowserView: UIViewControllerRepresentable {
    let site: Site
    func makeUIViewController(context: Context) -> BrowserViewController { BrowserViewController(site: site) }
    func updateUIViewController(_ vc: BrowserViewController, context: Context) {}
}

/// 리수 전용 웹뷰.
/// - 상단 프레임 이동은 허용 목록 호스트만, 나머지는 외부 브라우저로
/// - WebContent 프로세스가 죽으면(OOM) 마지막 주소로 조용히 복구 + 입력 초안 복원
final class BrowserViewController: UIViewController {
    let site: Site
    private var webView: WKWebView!
    private let hud = MemoryHUD()
    private let bridge = DraftBridge()
    private let crashLog = CrashLog()
    private var lastURL: URL?
    private var memoryObserver: NSObjectProtocol?

    init(site: Site) {
        self.site = site
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        webView = makeWebView()
        view.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        hud.attach(to: view)
        webView.load(URLRequest(url: site.url))

        memoryObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.hud.noteMemoryWarning()
            self?.crashLog.note("memory warning")
            // 페이지 쪽에서 이미지 캐시 등을 비울 수 있도록 신호만 보낸다.
            self?.webView.evaluateJavaScript("window.dispatchEvent(new Event('dusk-memory-warning'))")
        }
    }

    deinit {
        if let o = memoryObserver { NotificationCenter.default.removeObserver(o) }
    }

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        // 사이트별 분리 저장소 (영구)
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: site.storeID)
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isFraudulentWebsiteWarningEnabled = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.dataDetectorTypes = []
        config.upgradeKnownHostsToHTTPS = true

        bridge.siteID = site.id
        bridge.install(into: config.userContentController)
        crashLog.siteID = site.id
        crashLog.install(into: config.userContentController)

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsLinkPreview = false
        wv.allowsBackForwardNavigationGestures = true
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        wv.backgroundColor = .black
        #if DEBUG
        wv.isInspectable = true
        #else
        wv.isInspectable = false
        #endif
        return wv
    }

    private func isAllowed(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return site.allowedHosts.contains(host)
    }
}

extension BrowserViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }

        // 데이터·blob 다운로드 등 페이지 내부 스킴
        if ["about", "blob", "data"].contains(url.scheme ?? "") { return decisionHandler(.allow) }

        // 하위 프레임: https만 허용
        if action.targetFrame?.isMainFrame == false {
            return decisionHandler(url.scheme == "https" ? .allow : .cancel)
        }

        if isAllowed(url) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
        } else {
            decisionHandler(.cancel)
            if url.scheme == "https" || url.scheme == "http" {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        lastURL = webView.url
    }

    /// OOM 등으로 WebContent 프로세스가 종료됐을 때
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        hud.noteCrash()
        crashLog.dump(reason: "web content process terminated")
        let target = lastURL ?? site.url
        webView.load(URLRequest(url: target))
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = DownloadHandler.shared
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = DownloadHandler.shared
    }
}

extension BrowserViewController: WKUIDelegate {
    /// 새 창은 만들지 않는다. 허용 주소면 현재 창에서, 아니면 외부로.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isAllowed(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        present(a, animated: true)
    }

    // 카메라·마이크 권한 요청은 전부 거절
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }
}
