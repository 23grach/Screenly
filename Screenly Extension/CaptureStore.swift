//
//  CaptureStore.swift
//  Screenly Extension
//

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

final class CaptureStore {
    static let shared = CaptureStore()

    private let fileManager = FileManager.default
    private let rootURL: URL
    private let sessionsURL: URL
    private let capturesURL: URL
    private let clipboardSessionsURL: URL
    private let maxChunkLength = 2 * 1024 * 1024
    private let maxClipboardBytes: Int64 = 250 * 1024 * 1024

    private init() {
        let applicationSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        rootURL = applicationSupport
            .appendingPathComponent("Screenly", isDirectory: true)
            .appendingPathComponent("SafariExtension", isDirectory: true)
        sessionsURL = rootURL.appendingPathComponent("Sessions", isDirectory: true)
        capturesURL = rootURL.appendingPathComponent("Captures", isDirectory: true)
        clipboardSessionsURL = rootURL.appendingPathComponent("ClipboardSessions", isDirectory: true)
    }

    func beginSession(mode: String) throws -> [String: Any] {
        try prepareRoot()
        try cleanupOldFiles()

        guard mode == "visible" || mode == "fullPage" else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid capture mode.")
        }

        let id = UUID().uuidString
        let sessionURL = sessionURL(id)
        try fileManager.createDirectory(at: sessionURL, withIntermediateDirectories: true)

        return [
            "sessionId": id,
            "captureId": id
        ]
    }

    @discardableResult
    func appendSegmentChunk(sessionID: String, segmentIndex: Int, base64Chunk: String) throws -> Int {
        guard base64Chunk.count <= maxChunkLength else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an oversized screenshot chunk.")
        }
        guard let data = Data(base64Encoded: base64Chunk, options: [.ignoreUnknownCharacters]) else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid screenshot chunk.")
        }

        let url = partialSegmentURL(sessionID: sessionID, index: segmentIndex)
        try ensureSessionExists(sessionID)

        if !fileManager.fileExists(atPath: url.path) {
            fileManager.createFile(atPath: url.path, contents: nil)
        }

        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        return data.count
    }

    func finishSegment(sessionID: String, segmentIndex: Int) throws -> SegmentFileInfo {
        let partialURL = partialSegmentURL(sessionID: sessionID, index: segmentIndex)
        let finalURL = segmentURL(sessionID: sessionID, index: segmentIndex)

        guard fileManager.fileExists(atPath: partialURL.path) else {
            throw ScreenlyNativeError(code: "capture_failed", message: "Screenly could not read the captured image segment.")
        }

        if fileManager.fileExists(atPath: finalURL.path) {
            try fileManager.removeItem(at: finalURL)
        }
        try fileManager.moveItem(at: partialURL, to: finalURL)

        let dimensions = try pngDimensions(at: finalURL)
        let attributes = try fileManager.attributesOfItem(atPath: finalURL.path)
        let byteLength = (attributes[.size] as? NSNumber)?.int64Value ?? 0

        return SegmentFileInfo(index: segmentIndex, width: dimensions.width, height: dimensions.height, byteLength: byteLength)
    }

    func finalizeSession(
        sessionID: String,
        captureID: String,
        mode: String,
        outputWidth: Int,
        outputHeight: Int,
        segments: [StitchSegment]
    ) throws -> CaptureInfo {
        try ensureSessionExists(sessionID)
        guard !segments.isEmpty else {
            throw ScreenlyNativeError(code: "capture_failed", message: "Screenly did not receive any screenshot data.")
        }

        let captureURL = captureURL(captureID)
        if fileManager.fileExists(atPath: captureURL.path) {
            try fileManager.removeItem(at: captureURL)
        }

        if mode == "visible" {
            guard segments.count == 1 else {
                throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received invalid visible-capture data.")
            }
            try fileManager.copyItem(at: segmentURL(sessionID: sessionID, index: segments[0].index), to: captureURL)
        } else if mode == "fullPage" {
            try ImageStitcher.stitch(
                sessionURL: sessionURL(sessionID),
                outputURL: captureURL,
                outputWidth: outputWidth,
                outputHeight: outputHeight,
                segments: segments
            )
        } else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid capture mode.")
        }

        let dimensions = try pngDimensions(at: captureURL)
        let attributes = try fileManager.attributesOfItem(atPath: captureURL.path)
        let byteLength = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let info = CaptureInfo(id: captureID, mode: mode, width: dimensions.width, height: dimensions.height, byteLength: byteLength)

        try? fileManager.removeItem(at: sessionURL(sessionID))

        return info
    }

    func readCaptureChunk(captureID: String, offset: Int64, length: Int) throws -> [String: Any] {
        guard offset >= 0, length > 0, length <= maxChunkLength else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid preview request.")
        }

        let url = captureURL(captureID)
        guard fileManager.fileExists(atPath: url.path) else {
            throw ScreenlyNativeError(code: "capture_not_found", message: "Screenly could not find the captured screenshot.")
        }

        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        let totalBytes = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        guard offset <= totalBytes else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid preview offset.")
        }

        let bytesToRead = min(Int64(length), totalBytes - offset)
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let data = try handle.read(upToCount: Int(bytesToRead)) ?? Data()

        return [
            "chunk": data.base64EncodedString(),
            "offset": offset,
            "bytesRead": data.count,
            "totalBytes": totalBytes,
            "done": offset + Int64(data.count) >= totalBytes,
            "mimeType": "image/png"
        ]
    }

    func beginClipboardCopy(byteLength: Int64) throws -> [String: Any] {
        try prepareRoot()
        try cleanupOldFiles()

        guard byteLength > 0, byteLength <= maxClipboardBytes else {
            throw ScreenlyNativeError(code: "clipboard_failed", message: "This screenshot is too large to copy to the clipboard.")
        }

        let id = UUID().uuidString
        let url = clipboardURL(id)
        fileManager.createFile(atPath: url.path, contents: nil)
        return [
            "clipboardSessionId": id,
            "maxChunkLength": maxChunkLength
        ]
    }

    @discardableResult
    func appendClipboardChunk(clipboardSessionID: String, base64Chunk: String) throws -> Int {
        guard base64Chunk.count <= maxChunkLength else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an oversized clipboard chunk.")
        }
        guard let data = Data(base64Encoded: base64Chunk, options: [.ignoreUnknownCharacters]) else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid clipboard chunk.")
        }

        let url = clipboardURL(clipboardSessionID)
        guard fileManager.fileExists(atPath: url.path) else {
            throw ScreenlyNativeError(code: "clipboard_failed", message: "Screenly could not prepare the clipboard image.")
        }

        let currentSize = ((try? fileManager.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value) ?? 0
        guard currentSize + Int64(data.count) <= maxClipboardBytes else {
            throw ScreenlyNativeError(code: "clipboard_failed", message: "This screenshot is too large to copy to the clipboard.")
        }

        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        return data.count
    }

    func finishClipboardCopy(clipboardSessionID: String) throws -> [String: Any] {
        let url = clipboardURL(clipboardSessionID)
        defer { try? fileManager.removeItem(at: url) }

        guard fileManager.fileExists(atPath: url.path) else {
            throw ScreenlyNativeError(code: "clipboard_failed", message: "Screenly could not prepare the clipboard image.")
        }

        let dimensions = try pngDimensions(at: url)
        let pngData = try Data(contentsOf: url)
        try copyPNGDataToPasteboard(pngData)

        return [
            "copied": true,
            "width": dimensions.width,
            "height": dimensions.height,
            "byteLength": pngData.count
        ]
    }

    func deleteClipboardCopy(clipboardSessionID: String) throws {
        let url = clipboardURL(clipboardSessionID)
        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
    }

    func deleteCapture(captureID: String) throws {
        let pngURL = captureURL(captureID)
        if fileManager.fileExists(atPath: pngURL.path) {
            try fileManager.removeItem(at: pngURL)
        }
    }

    private func prepareRoot() throws {
        try fileManager.createDirectory(at: sessionsURL, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: capturesURL, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: clipboardSessionsURL, withIntermediateDirectories: true)
    }

    private func ensureSessionExists(_ sessionID: String) throws {
        let url = sessionURL(sessionID)
        guard fileManager.fileExists(atPath: url.path) else {
            throw ScreenlyNativeError(code: "capture_failed", message: "Screenly could not find the active capture session.")
        }
    }

    private func sessionURL(_ sessionID: String) -> URL {
        sessionsURL.appendingPathComponent(sessionID, isDirectory: true)
    }

    private func segmentURL(sessionID: String, index: Int) -> URL {
        sessionURL(sessionID).appendingPathComponent("segment-\(index).png")
    }

    private func partialSegmentURL(sessionID: String, index: Int) -> URL {
        sessionURL(sessionID).appendingPathComponent("segment-\(index).png.partial")
    }

    private func captureURL(_ captureID: String) -> URL {
        capturesURL.appendingPathComponent("\(captureID).png")
    }

    private func clipboardURL(_ clipboardSessionID: String) -> URL {
        clipboardSessionsURL.appendingPathComponent("\(clipboardSessionID).png.partial")
    }

    private func pngDimensions(at url: URL) throws -> (width: Int, height: Int) {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            throw ScreenlyNativeError(code: "capture_failed", message: "Screenly could not decode the captured PNG.")
        }
        if let type = CGImageSourceGetType(source), type as String != UTType.png.identifier {
            throw ScreenlyNativeError(code: "capture_failed", message: "Screenly received image data that is not PNG.")
        }
        guard
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
            let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
            width.intValue > 0,
            height.intValue > 0
        else {
            throw ScreenlyNativeError(code: "capture_failed", message: "Screenly could not read the captured PNG dimensions.")
        }
        return (width.intValue, height.intValue)
    }

    private func copyPNGDataToPasteboard(_ pngData: Data) throws {
        let item = NSPasteboardItem()
        item.setData(pngData, forType: .png)
        if let image = NSImage(data: pngData), let tiffData = image.tiffRepresentation {
            item.setData(tiffData, forType: .tiff)
        }

        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        guard pasteboard.writeObjects([item]) else {
            throw ScreenlyNativeError(code: "clipboard_failed", message: "Screenly could not copy the image to the clipboard.")
        }
    }

    private func cleanupOldFiles() throws {
        let cutoff = Date().addingTimeInterval(-30 * 60)
        for directory in [sessionsURL, capturesURL, clipboardSessionsURL] where fileManager.fileExists(atPath: directory.path) {
            let urls = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])
            for url in urls {
                let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
                if let date = values?.contentModificationDate, date < cutoff {
                    try? fileManager.removeItem(at: url)
                }
            }
        }
    }
}

struct SegmentFileInfo {
    let index: Int
    let width: Int
    let height: Int
    let byteLength: Int64

    var dictionary: [String: Any] {
        [
            "index": index,
            "width": width,
            "height": height,
            "byteLength": byteLength
        ]
    }
}

struct CaptureInfo {
    let id: String
    let mode: String
    let width: Int
    let height: Int
    let byteLength: Int64

    var dictionary: [String: Any] {
        [
            "captureId": id,
            "mode": mode,
            "width": width,
            "height": height,
            "byteLength": byteLength
        ]
    }
}
