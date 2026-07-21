import AppKit

@MainActor
final class FixtureViewController: NSViewController {
    private let eventLog = NSTextView()

    override func loadView() {
        view = NSView()
        view.setAccessibilityIdentifier("fixture.root")

        let title = NSTextField(labelWithString: "Deterministic Accessibility Controls")
        title.font = .preferredFont(forTextStyle: .title1)

        let button = NSButton(title: "Fixture Button", target: self, action: #selector(buttonPressed))
        button.setAccessibilityIdentifier("fixture.button")

        let checkbox = NSButton(checkboxWithTitle: "Fixture Checkbox", target: self, action: #selector(checkboxChanged(_:)))
        checkbox.setAccessibilityIdentifier("fixture.checkbox")

        let text = NSTextField(string: "editable fixture text")
        text.placeholderString = "Fixture text"
        text.setAccessibilityIdentifier("fixture.text")

        let secure = NSSecureTextField(string: "")
        secure.placeholderString = "Secure fixture value"
        secure.setAccessibilityIdentifier("fixture.secure")

        let popup = NSPopUpButton()
        popup.addItems(withTitles: ["Alpha", "Beta", "Gamma"])
        popup.target = self
        popup.action = #selector(popupChanged(_:))
        popup.setAccessibilityIdentifier("fixture.popup")

        let scrollDocument = NSTextView()
        scrollDocument.string = (1...40).map { "Scrollable fixture row \($0)" }.joined(separator: "\n")
        scrollDocument.isEditable = false
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = scrollDocument
        scroll.heightAnchor.constraint(equalToConstant: 120).isActive = true
        scroll.setAccessibilityIdentifier("fixture.scroll")

        let secondary = NSButton(title: "Secondary Action Target", target: self, action: #selector(secondaryPressed))
        secondary.setAccessibilityIdentifier("fixture.secondary")
        let menu = NSMenu()
        menu.addItem(withTitle: "Fixture Secondary Action", action: #selector(secondaryPressed), keyEquivalent: "")
        secondary.menu = menu

        let dragSource = DraggableFixtureLabel { [weak self] in self?.record("drag-started") }
        dragSource.setAccessibilityIdentifier("fixture.drag-source")
        let dragDestination = FixtureDropTarget { [weak self] in self?.record("drag-completed") }
        dragDestination.setAccessibilityIdentifier("fixture.drag-destination")
        let dragRow = NSStackView(views: [dragSource, dragDestination])
        dragRow.orientation = .horizontal
        dragRow.distribution = .fillEqually
        dragRow.spacing = 12

        let sheetButton = NSButton(title: "Open Sheet", target: self, action: #selector(openSheet))
        sheetButton.setAccessibilityIdentifier("fixture.sheet.open")

        eventLog.isEditable = false
        eventLog.string = "Fixture ready\n"
        eventLog.setAccessibilityIdentifier("fixture.event-log")
        let logScroll = NSScrollView()
        logScroll.hasVerticalScroller = true
        logScroll.documentView = eventLog
        logScroll.heightAnchor.constraint(equalToConstant: 110).isActive = true

        let stack = NSStackView(views: [
            title, button, checkbox, text, secure, popup, scroll, secondary, dragRow, sheetButton,
            NSTextField(labelWithString: "Event log"), logScroll,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -24),
            text.widthAnchor.constraint(equalTo: stack.widthAnchor),
            secure.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            logScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            dragRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    func record(_ event: String) {
        eventLog.string += "\(event)\n"
        eventLog.scrollToEndOfDocument(nil)
    }

    @objc private func buttonPressed() { record("button-pressed") }
    @objc private func checkboxChanged(_ sender: NSButton) { record("checkbox-\(sender.state == .on ? "on" : "off")") }
    @objc private func popupChanged(_ sender: NSPopUpButton) { record("popup-\(sender.titleOfSelectedItem ?? "unknown")") }
    @objc private func secondaryPressed() { record("secondary-action") }
    @objc private func openSheet() { (view.window?.windowController as? FixtureWindowController)?.showFixtureSheet() }
}

@MainActor
final class DraggableFixtureLabel: NSTextField, NSDraggingSource {
    private let didBegin: @MainActor () -> Void

    init(didBegin: @escaping @MainActor () -> Void) {
        self.didBegin = didBegin
        super.init(frame: .zero)
        stringValue = "Drag source"
        isEditable = false
        isBezeled = true
        alignment = .center
        heightAnchor.constraint(equalToConstant: 44).isActive = true
    }

    required init?(coder: NSCoder) { nil }

    override func mouseDragged(with event: NSEvent) {
        didBegin()
        let item = NSDraggingItem(pasteboardWriter: "fixture-drag" as NSString)
        item.setDraggingFrame(bounds, contents: nil)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }
}

@MainActor
final class FixtureDropTarget: NSBox {
    private let didDrop: @MainActor () -> Void

    init(didDrop: @escaping @MainActor () -> Void) {
        self.didDrop = didDrop
        super.init(frame: .zero)
        title = "Drag destination"
        boxType = .custom
        borderWidth = 1
        borderColor = .separatorColor
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Drag destination")
        heightAnchor.constraint(equalToConstant: 44).isActive = true
        registerForDraggedTypes([.string])
    }

    required init?(coder: NSCoder) { nil }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation { .copy }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        guard sender.draggingPasteboard.string(forType: .string) == "fixture-drag" else { return false }
        didDrop()
        return true
    }
}
