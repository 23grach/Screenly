//
//  ViewController.swift
//  Screenly
//

import Cocoa
import SafariServices

private let extensionBundleIdentifier = "gr-ch.Screenly.Extension"

final class ViewController: NSViewController {
    private let contentView = NSVisualEffectView()
    private let symbolView = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "Screenly")
    private let subtitleLabel = NSTextField(labelWithString: "Safari screenshot capture")
    private let statusIndicator = NSImageView()
    private let statusTitleLabel = NSTextField(labelWithString: "")
    private let statusDetailLabel = NSTextField(labelWithString: "")
    private let openSettingsButton = NSButton(title: "Open Safari Settings", target: nil, action: nil)

    override func viewDidLoad() {
        super.viewDidLoad()
        buildInterface()
        refreshExtensionState()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(refreshExtensionState),
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func buildInterface() {
        view.wantsLayer = true

        contentView.material = .windowBackground
        contentView.blendingMode = .behindWindow
        contentView.state = .active
        contentView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(contentView)

        let headerStack = makeHeaderStack()
        let statusPanel = makeStatusPanel()

        openSettingsButton.target = self
        openSettingsButton.action = #selector(openSafariExtensionSettings)
        openSettingsButton.bezelStyle = .rounded
        openSettingsButton.controlSize = .large
        openSettingsButton.font = .systemFont(ofSize: NSFont.systemFontSize(for: .large), weight: .semibold)
        openSettingsButton.translatesAutoresizingMaskIntoConstraints = false

        let mainStack = NSStackView(views: [headerStack, statusPanel, openSettingsButton])
        mainStack.orientation = .vertical
        mainStack.alignment = .centerX
        mainStack.spacing = 22
        mainStack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(mainStack)

        NSLayoutConstraint.activate([
            contentView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            contentView.topAnchor.constraint(equalTo: view.topAnchor),
            contentView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            mainStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 36),
            mainStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -36),
            mainStack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),

            statusPanel.widthAnchor.constraint(equalTo: mainStack.widthAnchor),
            openSettingsButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 196)
        ])
    }

    private func makeHeaderStack() -> NSStackView {
        let symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 44, weight: .semibold)
        symbolView.image = NSImage(systemSymbolName: "camera.viewfinder", accessibilityDescription: "Screenly")?
            .withSymbolConfiguration(symbolConfiguration)
        symbolView.contentTintColor = .controlAccentColor
        symbolView.imageScaling = .scaleProportionallyUpOrDown
        symbolView.translatesAutoresizingMaskIntoConstraints = false

        titleLabel.alignment = .center
        titleLabel.font = .systemFont(ofSize: 28, weight: .bold)
        titleLabel.textColor = .labelColor

        subtitleLabel.alignment = .center
        subtitleLabel.font = .systemFont(ofSize: 13, weight: .regular)
        subtitleLabel.textColor = .secondaryLabelColor

        let textStack = NSStackView(views: [titleLabel, subtitleLabel])
        textStack.orientation = .vertical
        textStack.alignment = .centerX
        textStack.spacing = 4

        let stack = NSStackView(views: [symbolView, textStack])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14

        NSLayoutConstraint.activate([
            symbolView.widthAnchor.constraint(equalToConstant: 68),
            symbolView.heightAnchor.constraint(equalToConstant: 68)
        ])

        return stack
    }

    private func makeStatusPanel() -> NSView {
        let panel = NSBox()
        panel.boxType = .custom
        panel.borderWidth = 1
        panel.cornerRadius = 12
        panel.borderColor = .separatorColor
        panel.fillColor = NSColor.controlBackgroundColor.withAlphaComponent(0.72)
        panel.contentViewMargins = NSSize(width: 18, height: 16)
        panel.translatesAutoresizingMaskIntoConstraints = false

        statusIndicator.imageScaling = .scaleProportionallyUpOrDown
        statusIndicator.translatesAutoresizingMaskIntoConstraints = false

        statusTitleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        statusTitleLabel.textColor = .labelColor

        statusDetailLabel.font = .systemFont(ofSize: 12, weight: .regular)
        statusDetailLabel.textColor = .secondaryLabelColor
        statusDetailLabel.lineBreakMode = .byWordWrapping
        statusDetailLabel.maximumNumberOfLines = 0

        let textStack = NSStackView(views: [statusTitleLabel, statusDetailLabel])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 3

        let row = NSStackView(views: [statusIndicator, textStack])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false

        panel.contentView?.addSubview(row)

        NSLayoutConstraint.activate([
            statusIndicator.widthAnchor.constraint(equalToConstant: 22),
            statusIndicator.heightAnchor.constraint(equalToConstant: 22),

            row.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor),
            row.topAnchor.constraint(equalTo: panel.contentView!.topAnchor),
            row.bottomAnchor.constraint(equalTo: panel.contentView!.bottomAnchor)
        ])

        return panel
    }

    @objc private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { [weak self] state, error in
            DispatchQueue.main.async {
                guard let self else { return }

                if let error {
                    self.applyStatus(
                        symbolName: "exclamationmark.triangle.fill",
                        tint: .systemOrange,
                        title: "Safari extension status unavailable",
                        detail: "Screenly could not read Safari's extension state. \(error.localizedDescription)"
                    )
                    self.openSettingsButton.isEnabled = true
                    return
                }

                if state?.isEnabled == true {
                    self.applyStatus(
                        symbolName: "checkmark.circle.fill",
                        tint: .systemGreen,
                        title: "Extension is enabled",
                        detail: "Use the Screenly toolbar button in Safari to capture the visible area or the full page."
                    )
                } else {
                    self.applyStatus(
                        symbolName: "exclamationmark.circle.fill",
                        tint: .systemOrange,
                        title: "Extension is not enabled",
                        detail: "Open Safari Settings and enable Screenly. If it is missing during local development, use Safari's Develop menu to allow unsigned extensions or sign both targets with your Apple development team."
                    )
                }

                self.openSettingsButton.isEnabled = true
            }
        }
    }

    private func applyStatus(symbolName: String, tint: NSColor, title: String, detail: String) {
        let configuration = NSImage.SymbolConfiguration(pointSize: 18, weight: .semibold)
        statusIndicator.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: title)?
            .withSymbolConfiguration(configuration)
        statusIndicator.contentTintColor = tint
        statusTitleLabel.stringValue = title
        statusDetailLabel.stringValue = detail
    }

    @objc private func openSafariExtensionSettings() {
        openSettingsButton.isEnabled = false

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            DispatchQueue.main.async {
                if let error {
                    self.openSettingsButton.isEnabled = true
                    self.showErrorAlert(message: "Screenly could not open Safari Settings.", detail: error.localizedDescription)
                    return
                }

                NSApplication.shared.terminate(nil)
            }
        }
    }

    private func showErrorAlert(message: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}
