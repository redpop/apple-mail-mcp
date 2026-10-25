import Foundation

/// Faltung fuer Vergleiche: klein, NFC, ss fuer scharfes S. Diakritika bleiben erhalten.
/// Muss exakt der Node-Funktion `toLowerCase().normalize('NFC').replaceAll('ß','ss')` entsprechen.
// Bekannte Abweichung zu JS toLowerCase beim griechischen Schluss-Sigma; unkritisch, weil in Swift
// beide Seiten jeder DB-Suche gefaltet werden.
public func fold(_ s: String) -> String {
    // Reines ASCII: nur Kleinschreibung, NFC und ss-Ersatz aendern nichts (gleiches Ergebnis wie der allgemeine Weg).
    if s.utf8.allSatisfy({ $0 < 0x80 }) { return s.lowercased() }
    return s.lowercased()
        .precomposedStringWithCanonicalMapping
        .replacingOccurrences(of: "ß", with: "ss")
}
