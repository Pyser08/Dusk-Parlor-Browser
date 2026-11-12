import Foundation

/// 접속을 허용하는 사이트 하나. 사이트마다 저장소(쿠키·IndexedDB)가 분리된다.
struct Site: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var url: URL
    /// 상단 프레임 이동을 허용할 추가 호스트 (로그인 리다이렉트 등)
    var extraHosts: [String]

    var allowedHosts: Set<String> {
        var hosts = Set(extraHosts.map { $0.lowercased() })
        if let h = url.host?.lowercased() { hosts.insert(h) }
        return hosts
    }

    /// 사이트별 고정 저장소 ID (iOS 17+ WKWebsiteDataStore(forIdentifier:))
    var storeID: UUID {
        UUID(uuidString: SiteStore.storeIDs[id] ?? "") ?? SiteStore.makeStoreID(for: id)
    }
}

final class SiteStore: ObservableObject {
    @Published var sites: [Site] = []
    private static let key = "dusk.sites"
    private static let idKey = "dusk.storeIDs"

    static var storeIDs: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: idKey) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: idKey) }
    }

    static func makeStoreID(for siteID: String) -> UUID {
        let id = UUID()
        var ids = storeIDs
        ids[siteID] = id.uuidString
        storeIDs = ids
        return id
    }

    init() { load() }

    func load() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let saved = try? JSONDecoder().decode([Site].self, from: data) {
            sites = saved
            return
        }
        if let url = Bundle.main.url(forResource: "sites", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let defaults = try? JSONDecoder().decode([Site].self, from: data) {
            sites = defaults
        }
    }

    func save() {
        if let data = try? JSONEncoder().encode(sites) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }

    func add(name: String, url: URL) {
        guard url.scheme == "https" else { return }
        sites.append(Site(id: UUID().uuidString, name: name, url: url, extraHosts: []))
        save()
    }

    func remove(at offsets: IndexSet) {
        sites.remove(atOffsets: offsets)
        save()
    }
}
