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

    /// Entfernt ein fuehrendes `<` und ein abschliessendes `>`: der Index liefert den Header mit
    /// Klammern, Mail eventuell ohne. Ohne das entstuende beim Vergleich `<<...>>`.
    private static func strippingBrackets(_ value: String) -> String {
        var bare = Substring(value)
        if bare.hasPrefix("<") { bare = bare.dropFirst() }
        if bare.hasSuffix(">") { bare = bare.dropLast() }
        return String(bare)
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
        let bareMessageId = strippingBrackets(expectedMessageId)
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
            if mid is \(literal(bareMessageId)) or mid is \(literal("<" + bareMessageId + ">")) then
              move m to dst
              return "moved"
            end if
            return "mismatch"
          end tell
        end timeout
        """
    }

    /// Speichert einen Anhang unter `path` und nur, wenn die `message id` passt. Der Rahmen ist
    /// der von `move`. Das Ergebnis ist `saved`, `not_found`, `mismatch`, `folder_not_found`,
    /// `attachment_not_found` oder `too_large`. `partId` ist die `id` des Anhangs und in Mail Text.
    /// `file size` kann werfen; dann entscheidet die Node-Seite ueber die Groesse. Nie `MIME type`:
    /// das wirft -10000. Das Bundle baut nur den Pfadtext; die Datei legt Mail an.
    public static func saveAttachment(
        account: String, source: String, rowid: Int64, expectedMessageId: String,
        partId: String, path: String, maxBytes: Int64
    ) -> String {
        let bareMessageId = strippingBrackets(expectedMessageId)
        return """
        with timeout of 90 seconds
          tell application "Mail"
            try
              set src to mailbox \(literal(source)) of account \(literal(account))
              get name of src
            on error number n
              if n is -1728 then return "folder_not_found"
              error number n
            end try
            set msgs to (messages of src whose id is \(rowid))
            if (count of msgs) is 0 then return "not_found"
            set m to item 1 of msgs
            set mid to message id of m
            if mid is \(literal(bareMessageId)) or mid is \(literal("<" + bareMessageId + ">")) then
              set atts to (mail attachments of m whose id is \(literal(partId)))
              if (count of atts) is 0 then return "attachment_not_found"
              set a to item 1 of atts
              try
                if (file size of a) > \(maxBytes) then return "too_large"
              end try
              save a in (POSIX file \(literal(path)))
              return "saved"
            end if
            return "mismatch"
          end tell
        end timeout
        """
    }
}
