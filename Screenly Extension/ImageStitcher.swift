//
//  ImageStitcher.swift
//  Screenly Extension
//

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct StitchSegment {
    let index: Int
    let sourceWidth: Int
    let sourceHeight: Int
    let cropX: Int
    let cropY: Int
    let cropWidth: Int
    let cropHeight: Int
    let destX: Int
    let destY: Int
    let destWidth: Int
    let destHeight: Int

    init(dictionary: [String: Any]) throws {
        index = try Payload.int("index", in: dictionary)
        sourceWidth = try Payload.int("sourceWidth", in: dictionary)
        sourceHeight = try Payload.int("sourceHeight", in: dictionary)
        cropX = try Payload.int("cropX", in: dictionary)
        cropY = try Payload.int("cropY", in: dictionary)
        cropWidth = try Payload.int("cropWidth", in: dictionary)
        cropHeight = try Payload.int("cropHeight", in: dictionary)
        destX = try Payload.int("destX", in: dictionary)
        destY = try Payload.int("destY", in: dictionary)
        destWidth = try Payload.int("destWidth", in: dictionary)
        destHeight = try Payload.int("destHeight", in: dictionary)
    }
}

enum ImageStitcher {
    private static let maxPixels: Int64 = 120_000_000
    private static let maxLongEdge = 65_000

    static func stitch(sessionURL: URL, outputURL: URL, outputWidth: Int, outputHeight: Int, segments: [StitchSegment]) throws {
        try validateCanvas(width: outputWidth, height: outputHeight)

        let bytesPerRow = try validatedBytesPerRow(width: outputWidth)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly could not prepare the screenshot canvas.")
        }

        guard let context = CGContext(
            data: nil,
            width: outputWidth,
            height: outputHeight,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw ScreenlyNativeError(code: "page_too_large", message: "This page is too large to stitch on this Mac.")
        }

        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))
        context.interpolationQuality = .none

        for segment in segments.sorted(by: { $0.index < $1.index }) {
            try autoreleasepool {
                let url = sessionURL.appendingPathComponent("segment-\(segment.index).png")
                guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                    throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly could not decode a captured image segment.")
                }

                try validate(segment: segment, image: image, outputWidth: outputWidth, outputHeight: outputHeight)

                let cropRect = CGRect(
                    x: segment.cropX,
                    y: segment.cropY,
                    width: segment.cropWidth,
                    height: segment.cropHeight
                )
                guard let cropped = image.cropping(to: cropRect) else {
                    throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly could not crop a captured image segment.")
                }

                // JavaScript reports page coordinates from the top; CoreGraphics draws bitmap contexts from the bottom.
                let destinationY = outputHeight - segment.destY - segment.destHeight
                let destinationRect = CGRect(
                    x: segment.destX,
                    y: destinationY,
                    width: segment.destWidth,
                    height: segment.destHeight
                )
                context.draw(cropped, in: destinationRect)
            }
        }

        guard let image = context.makeImage() else {
            throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly could not create the stitched screenshot.")
        }

        let temporaryURL = outputURL.deletingLastPathComponent().appendingPathComponent("\(outputURL.lastPathComponent).tmp")
        if FileManager.default.fileExists(atPath: temporaryURL.path) {
            try FileManager.default.removeItem(at: temporaryURL)
        }
        guard let destination = CGImageDestinationCreateWithURL(temporaryURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly could not create the stitched PNG.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly could not write the stitched PNG.")
        }

        if FileManager.default.fileExists(atPath: outputURL.path) {
            try FileManager.default.removeItem(at: outputURL)
        }
        try FileManager.default.moveItem(at: temporaryURL, to: outputURL)
    }

    private static func validateCanvas(width: Int, height: Int) throws {
        guard width > 0, height > 0 else {
            throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly received invalid screenshot dimensions.")
        }
        guard width <= maxLongEdge, height <= maxLongEdge else {
            throw ScreenlyNativeError(code: "page_too_large", message: "This page is too large to capture as one PNG.")
        }
        let pixels = Int64(width) * Int64(height)
        guard pixels <= maxPixels else {
            throw ScreenlyNativeError(code: "page_too_large", message: "This page is too large to capture as one PNG.")
        }
    }

    private static func validatedBytesPerRow(width: Int) throws -> Int {
        let bytes = Int64(width) * 4
        guard bytes <= Int64(Int.max) else {
            throw ScreenlyNativeError(code: "page_too_large", message: "This page is too large to capture as one PNG.")
        }
        return Int(bytes)
    }

    private static func validate(segment: StitchSegment, image: CGImage, outputWidth: Int, outputHeight: Int) throws {
        guard image.width == segment.sourceWidth, image.height == segment.sourceHeight else {
            throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly received inconsistent screenshot segment dimensions.")
        }
        guard segment.cropX >= 0,
              segment.cropY >= 0,
              segment.cropWidth > 0,
              segment.cropHeight > 0,
              segment.cropX + segment.cropWidth <= image.width,
              segment.cropY + segment.cropHeight <= image.height else {
            throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly received invalid crop data for a screenshot segment.")
        }
        guard segment.destX >= 0,
              segment.destY >= 0,
              segment.destWidth > 0,
              segment.destHeight > 0,
              segment.destX + segment.destWidth <= outputWidth,
              segment.destY + segment.destHeight <= outputHeight else {
            throw ScreenlyNativeError(code: "stitch_failed", message: "Screenly received invalid placement data for a screenshot segment.")
        }
    }
}
