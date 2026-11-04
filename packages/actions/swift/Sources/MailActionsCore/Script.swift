import Foundation

/// Erzeugt den AppleScript-Text, rein und ohne Zugriff auf Mail.
public enum Script {
    /// Ein Stringliteral. In AppleScript beendet nur `"` ein Literal und nur `\` schuetzt das
    /// naechste Zeichen; beide werden maskiert, damit ein Wert nicht aus dem Literal ausbrechen kann.
    /// Steuerzeichen weist der Dispatcher vorher ab.
    static func literal(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"" + escaped + "\""
    }

    /// Verschiebt genau eine Mail, und nur, wenn ihre `message id` passt: nach einem Neuaufbau von
    /// Mails Index kann die rowid eine andere Mail meinen. Index und Mail unterscheiden sich
    /// eventuell in den spitzen Klammern, daher der Vergleich mit beiden Formen.
    ///
    /// Das Ergebnis ist `moved`, `not_found`, `mismatch` oder `folder_not_found`. Der `try`-Block
    /// umfasst nur das Aufloesen der Ordner: `get name` erzwingt es, damit -1728 dort einen
    /// fehlenden Ordner meint und nicht eine fehlende Mail. Andere Fehler gehen nur mit ihrer
    /// Nummer weiter.
    public static func move(
        account: String, source: String, target: String, rowid: Int64, expectedMessageId: String
    ) -> String {
        let accountLiteral = literal(account)
        return """
        with timeout of 120 seconds
          tell application "Mail"
            try
              set src to mailbox \(literal(source)) of account \(accountLiteral)
              set dst to mailbox \(literal(target)) of account \(accountLiteral)
              get name of src
              get name of dst
            on error number n
              if n is -1728 then return "folder_not_found"
              error number n
            end try
            set msgs to (messages of src whose id is \(rowid))
            if (count of msgs) is 0 then return "not_found"
            set m to item 1 of msgs
            set mid to message id of m
            if mid is \(literal(expectedMessageId)) or mid is \(literal("<" + expectedMessageId + ">")) then
              move m to dst
              return "moved"
            end if
            return "mismatch"
          end tell
        end timeout
        """
    }
}
