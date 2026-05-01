//
//  NativeResponse.swift
//  Screenly Extension
//

import Foundation

enum NativeResponse {
    static func success(_ values: [String: Any]) -> [String: Any] {
        var response = values
        response["ok"] = true
        return response
    }

    static func failure(_ error: ScreenlyNativeError) -> [String: Any] {
        failure(code: error.code, message: error.message, developerMessage: error.developerMessage)
    }

    static func failure(code: String, message: String, developerMessage: String? = nil) -> [String: Any] {
        var error: [String: Any] = [
            "code": code,
            "message": message
        ]
        if let developerMessage {
            error["developerMessage"] = developerMessage
        }
        return [
            "ok": false,
            "error": error
        ]
    }
}

struct ScreenlyNativeError: Error {
    let code: String
    let message: String
    let developerMessage: String?

    init(code: String, message: String, developerMessage: String? = nil) {
        self.code = code
        self.message = message
        self.developerMessage = developerMessage
    }
}

enum Payload {
    static func string(_ key: String, in payload: [String: Any]) throws -> String {
        guard let value = payload[key] as? String, !value.isEmpty else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid request.", developerMessage: "Missing string field: \(key)")
        }
        return value
    }

    static func int(_ key: String, in payload: [String: Any]) throws -> Int {
        guard let value = numericValue(payload[key]) else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid request.", developerMessage: "Missing integer field: \(key)")
        }
        return Int(value)
    }

    static func int64(_ key: String, in payload: [String: Any]) throws -> Int64 {
        guard let value = numericValue(payload[key]) else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid request.", developerMessage: "Missing integer field: \(key)")
        }
        return value
    }

    static func array(_ key: String, in payload: [String: Any]) throws -> [Any] {
        guard let value = payload[key] as? [Any] else {
            throw ScreenlyNativeError(code: "invalid_message", message: "Screenly received an invalid request.", developerMessage: "Missing array field: \(key)")
        }
        return value
    }

    private static func numericValue(_ value: Any?) -> Int64? {
        if let value = value as? Int {
            return Int64(value)
        }
        if let value = value as? Int64 {
            return value
        }
        if let value = value as? NSNumber {
            return value.int64Value
        }
        if let value = value as? String {
            return Int64(value)
        }
        return nil
    }
}
