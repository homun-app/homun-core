import AppKit

@MainActor
public func runFixtureApplication() {
    let application = NSApplication.shared
    let delegate = FixtureAppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
    withExtendedLifetime(delegate) {}
}

@MainActor
final class FixtureAppDelegate: NSObject, NSApplicationDelegate {
    private var windowController: FixtureWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()
        let controller = FixtureWindowController()
        windowController = controller
        controller.showWindow(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func installMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Show Fixture Sheet",
            action: #selector(FixtureWindowController.showSheetFromMenu),
            keyEquivalent: "l"
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit Homun Computer Fixture",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appItem.submenu = appMenu
        NSApplication.shared.mainMenu = main
    }
}

@MainActor
final class FixtureWindowController: NSWindowController {
    private let fixtureController = FixtureViewController()

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Homun Computer Fixture"
        window.center()
        window.contentViewController = fixtureController
        super.init(window: window)
        window.setAccessibilityIdentifier("fixture.window")
    }

    required init?(coder: NSCoder) {
        nil
    }

    @objc func showSheetFromMenu() {
        showFixtureSheet()
    }

    func showFixtureSheet() {
        guard let window else { return }
        fixtureController.record("sheet-opened")
        let sheet = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 140),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        sheet.title = "Fixture Sheet"
        let close = NSButton(title: "Close Sheet", target: nil, action: nil)
        close.setAccessibilityIdentifier("fixture.sheet.close")
        close.translatesAutoresizingMaskIntoConstraints = false
        close.target = self
        close.action = #selector(closeSheet(_:))
        sheet.contentView = NSView()
        sheet.contentView?.addSubview(close)
        NSLayoutConstraint.activate([
            close.centerXAnchor.constraint(equalTo: sheet.contentView!.centerXAnchor),
            close.centerYAnchor.constraint(equalTo: sheet.contentView!.centerYAnchor),
        ])
        window.beginSheet(sheet)
    }

    @objc private func closeSheet(_ sender: NSButton) {
        guard let sheet = sender.window else { return }
        window?.endSheet(sheet)
        fixtureController.record("sheet-closed")
    }
}
