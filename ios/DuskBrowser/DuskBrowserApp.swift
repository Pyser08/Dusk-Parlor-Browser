import SwiftUI

@main
struct DuskBrowserApp: App {
    @StateObject private var store = SiteStore()

    var body: some Scene {
        WindowGroup {
            SiteListView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
    }
}

struct SiteListView: View {
    @EnvironmentObject var store: SiteStore
    @State private var adding = false
    @State private var newName = ""
    @State private var newURL = "https://"

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.sites) { site in
                    NavigationLink(value: site) {
                        VStack(alignment: .leading) {
                            Text(site.name)
                            Text(site.url.host ?? "").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete(perform: store.remove)
            }
            .navigationTitle("Dusk Browser")
            .navigationDestination(for: Site.self) { site in
                BrowserView(site: site)
                    .ignoresSafeArea(.container, edges: .bottom)
                    .toolbar(.hidden, for: .navigationBar)
            }
            .toolbar {
                Button { adding = true } label: { Image(systemName: "plus") }
            }
            .alert("사이트 추가", isPresented: $adding) {
                TextField("이름", text: $newName)
                TextField("https://...", text: $newURL)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                Button("추가") {
                    if let url = URL(string: newURL) { store.add(name: newName, url: url) }
                    newName = ""; newURL = "https://"
                }
                Button("취소", role: .cancel) {}
            } message: {
                Text("https 주소만 허용돼요.")
            }
        }
    }
}
