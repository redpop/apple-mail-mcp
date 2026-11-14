import Foundation

/// Basisordner fuer gespeicherte Anhaenge. Gleiche Regeln wie `resolveAttachmentDir` in
/// src/attachmentFiles.ts. Das Bundle fasst das Dateisystem nie an: es rechnet nur den Pfadtext aus.
enum AttachmentDir {
    /// nil = ungueltig (relativ, `~user/...`) oder ein noetiges Home fehlt. Keine Normalisierung.
    static func resolve(env: [String: String], home: String) -> String? {
        // Wie `raw()` in src/config.ts: getrimmt, nur Leerraum gilt als nicht gesetzt.
        let raw = (env["APPLE_MAIL_ATTACHMENT_DIR"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty {
            guard !home.isEmpty else { return nil }
            return home + "/Library/Caches/apple-mail-mcp/attachments"
        }
        if raw.hasPrefix("~/") {
            guard !home.isEmpty else { return nil }
            return home + raw.dropFirst()
        }
        if raw.hasPrefix("/") { return raw }
        return nil
    }

    /// `att-` plus sechs Buchstaben oder Ziffern.
    static func isSlot(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 10, bytes.starts(with: Array("att-".utf8)) else { return false }
        return bytes.dropFirst(4).allSatisfy {
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A)
        }
    }

    /// Nicht leer, hoechstens 200 Bytes, kein `/`, `:`, Steuerzeichen, kein fuehrender Punkt.
    static func isSafeFileName(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 200, value.utf8.first != 0x2E else { return false }
        return !value.unicodeScalars.contains {
            $0 == "/" || $0 == ":" || $0.value < 0x20 || $0.value == 0x7F
        }
    }

    /// `^[0-9]+(\.[0-9]+)*$`, nur ASCII-Ziffern.
    static func isPartId(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return !parts.isEmpty && parts.allSatisfy { part in
            !part.isEmpty && part.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
        }
    }
}
