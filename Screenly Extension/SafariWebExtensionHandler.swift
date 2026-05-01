//
//  SafariWebExtensionHandler.swift
//  Screenly Extension
//

import Foundation
import SafariServices
import os

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let logger = Logger(subsystem: "gr-ch.Screenly.Extension", category: "NativeMessaging")

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]

        guard let payload = message as? [String: Any] else {
            complete(context, with: NativeResponse.failure(
                code: "invalid_message",
                message: "Screenly received an invalid request.",
                developerMessage: "Expected a dictionary payload from browser.runtime.sendNativeMessage."
            ))
            return
        }

        logger.debug("Received native command: \(String(describing: payload["command"]), privacy: .public)")

        NativeCommandRouter.shared.handle(payload) { [weak self] response in
            self?.complete(context, with: response)
        }
    }

    private func complete(_ context: NSExtensionContext, with response: [String: Any]) {
        let item = NSExtensionItem()
        item.userInfo = [SFExtensionMessageKey: response]
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }
}
