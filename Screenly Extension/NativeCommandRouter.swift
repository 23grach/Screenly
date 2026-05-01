//
//  NativeCommandRouter.swift
//  Screenly Extension
//

import Foundation
import os

final class NativeCommandRouter {
    static let shared = NativeCommandRouter()

    private let logger = Logger(subsystem: "gr-ch.Screenly.Extension", category: "CommandRouter")
    private let store = CaptureStore.shared

    private init() {}

    func handle(_ message: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        do {
            let command = try Payload.string("command", in: message)

            switch command {
            case "beginSession":
                let mode = try Payload.string("mode", in: message)
                let response = try store.beginSession(mode: mode)
                completion(NativeResponse.success(response))

            case "appendSegmentChunk":
                let sessionID = try Payload.string("sessionId", in: message)
                let segmentIndex = try Payload.int("segmentIndex", in: message)
                let chunk = try Payload.string("chunk", in: message)
                let byteCount = try store.appendSegmentChunk(sessionID: sessionID, segmentIndex: segmentIndex, base64Chunk: chunk)
                completion(NativeResponse.success(["bytesWritten": byteCount]))

            case "finishSegment":
                let sessionID = try Payload.string("sessionId", in: message)
                let segmentIndex = try Payload.int("segmentIndex", in: message)
                let info = try store.finishSegment(sessionID: sessionID, segmentIndex: segmentIndex)
                completion(NativeResponse.success(info.dictionary))

            case "finalizeSession":
                let sessionID = try Payload.string("sessionId", in: message)
                let captureID = try Payload.string("captureId", in: message)
                let mode = try Payload.string("mode", in: message)
                let outputWidth = try Payload.int("outputWidth", in: message)
                let outputHeight = try Payload.int("outputHeight", in: message)
                let segmentPayloads = try Payload.array("segments", in: message)
                let segments = try segmentPayloads.map { value -> StitchSegment in
                    guard let dictionary = value as? [String: Any] else {
                        throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received invalid screenshot segment data.")
                    }
                    return try StitchSegment(dictionary: dictionary)
                }

                let capture = try store.finalizeSession(
                    sessionID: sessionID,
                    captureID: captureID,
                    mode: mode,
                    outputWidth: outputWidth,
                    outputHeight: outputHeight,
                    segments: segments
                )
                completion(NativeResponse.success(capture.dictionary))

            case "readCaptureChunk":
                let captureID = try Payload.string("captureId", in: message)
                let offset = try Payload.int64("offset", in: message)
                let length = try Payload.int("length", in: message)
                let chunk = try store.readCaptureChunk(captureID: captureID, offset: offset, length: length)
                completion(NativeResponse.success(chunk))

            case "beginClipboardCopy":
                let byteLength = try Payload.int64("byteLength", in: message)
                let response = try store.beginClipboardCopy(byteLength: byteLength)
                completion(NativeResponse.success(response))

            case "appendClipboardChunk":
                let clipboardSessionID = try Payload.string("clipboardSessionId", in: message)
                let chunk = try Payload.string("chunk", in: message)
                let byteCount = try store.appendClipboardChunk(clipboardSessionID: clipboardSessionID, base64Chunk: chunk)
                completion(NativeResponse.success(["bytesWritten": byteCount]))

            case "finishClipboardCopy":
                let clipboardSessionID = try Payload.string("clipboardSessionId", in: message)
                DispatchQueue.main.async {
                    do {
                        let response = try self.store.finishClipboardCopy(clipboardSessionID: clipboardSessionID)
                        completion(NativeResponse.success(response))
                    } catch let error as ScreenlyNativeError {
                        self.logger.error("Copy failed: \(error.developerMessage ?? error.message, privacy: .public)")
                        completion(NativeResponse.failure(error))
                    } catch {
                        self.logger.error("Copy failed: \(error.localizedDescription, privacy: .public)")
                        completion(NativeResponse.failure(code: "clipboard_failed", message: "Screenly could not copy the image to the clipboard.", developerMessage: error.localizedDescription))
                    }
                }

            case "deleteClipboardCopy":
                let clipboardSessionID = try Payload.string("clipboardSessionId", in: message)
                try store.deleteClipboardCopy(clipboardSessionID: clipboardSessionID)
                completion(NativeResponse.success([:]))

            case "deleteCapture":
                let captureID = try Payload.string("captureId", in: message)
                try store.deleteCapture(captureID: captureID)
                completion(NativeResponse.success([:]))

            default:
                throw ScreenlyNativeError(
                    code: "unknown_command",
                    message: "Screenly received an unsupported request.",
                    developerMessage: "Unsupported command: \(command)"
                )
            }
        } catch let error as ScreenlyNativeError {
            logger.error("Native command failed: \(error.developerMessage ?? error.message, privacy: .public)")
            completion(NativeResponse.failure(error))
        } catch {
            logger.error("Native command failed: \(error.localizedDescription, privacy: .public)")
            completion(NativeResponse.failure(
                code: "native_error",
                message: "Screenly could not complete the request.",
                developerMessage: error.localizedDescription
            ))
        }
    }
}
