import Foundation

/// Fehlercodes des Helpers (Spec 7.4).
public enum ErrorCode: String, Codable, Sendable {
    case fullDiskAccessRequired = "FULL_DISK_ACCESS_REQUIRED"
    case mailDataNotFound = "MAIL_DATA_NOT_FOUND"
    case schemaUnsupported = "SCHEMA_UNSUPPORTED"
    case databaseBusy = "DATABASE_BUSY"
    case databaseError = "DATABASE_ERROR"
    case messageNotFound = "MESSAGE_NOT_FOUND"
    case helperUntrustedSignature = "HELPER_UNTRUSTED_SIGNATURE"
    case invalidInput = "INVALID_INPUT"
}

/// Fehler mit Code und festem englischem Satz. `message` enthaelt nie Nutzerdaten
/// (keine Pfade mit Mailbox-Namen, keine SQL-Werte), nur feste Saetze und Spaltennamen.
public struct HelperFailure: Error, Sendable {
    public let code: ErrorCode
    public let message: String

    public init(code: ErrorCode, message: String) {
        self.code = code
        self.message = message
    }
}
