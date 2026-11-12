import UIKit

/// 디버그용 작은 표시창: 앱 프로세스 메모리, 메모리 경고 횟수, 웹 프로세스 종료(크래시) 횟수.
/// 주의: 웹 콘텐츠는 별도 프로세스라 그 메모리는 여기서 측정되지 않는다.
/// 세 손가락 두 번 탭으로 켜고 끈다.
final class MemoryHUD {
    private let label = UILabel()
    private var timer: Timer?
    private var warnings = 0
    private var crashes: Int {
        get { UserDefaults.standard.integer(forKey: "dusk.crashCount") }
        set { UserDefaults.standard.set(newValue, forKey: "dusk.crashCount") }
    }

    func attach(to view: UIView) {
        label.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        label.textColor = .white
        label.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        label.numberOfLines = 0
        label.isHidden = true
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -4),
            label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
        ])
        let tap = UITapGestureRecognizer(target: self, action: #selector(toggle))
        tap.numberOfTouchesRequired = 3
        tap.numberOfTapsRequired = 2
        view.addGestureRecognizer(tap)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func noteMemoryWarning() { warnings += 1; refresh() }
    func noteCrash() { crashes += 1; refresh() }

    @objc private func toggle() { label.isHidden.toggle() }

    private func refresh() {
        guard !label.isHidden else { return }
        let mb = Double(Self.footprint()) / 1_048_576
        label.text = String(format: " app %.0fMB  warn %d  webcrash %d ", mb, warnings, crashes)
    }

    static func footprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return kr == KERN_SUCCESS ? info.phys_footprint : 0
    }
}
