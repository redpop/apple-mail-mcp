import Foundation
import Testing
@testable import MailActionsCore

@Suite struct ScriptTests {
    /// Zerlegt AppleScript-Quelltext in seine Stringliterale, nach denselben Regeln wie der Compiler:
    /// `"` beendet das Literal, `\` schuetzt das naechste Zeichen. Liefert die Literale roh.
    private func literals(_ source: String) -> [String] {
        var result: [String] = []
        var current: String?
        var escaped = false
        for character in source {
            guard current != nil else {
                if character == "\"" { current = "" }
                continue
            }
            if escaped {
                current!.append(character)
                escaped = false
            } else if character == "\\" {
                current!.append(character)
                escaped = true
            } else if character == "\"" {
                result.append(current!)
                current = nil
            } else {
                current!.append(character)
            }
        }
        #expect(current == nil, "unterminated literal")
        return result
    }

    private func script(
        account: String = "Acc", source: String = "Src", target: String = "Dst",
        rowid: Int64 = 42, expected: String = "abc@example.com"
    ) -> String {
        Script.move(account: account, source: source, target: target, rowid: rowid, expectedMessageId: expected)
    }

    /// Zeilen ohne Einrueckung, zum Pruefen der Reihenfolge.
    private func lines(_ source: String) -> [String] {
        source.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    @Test func quotesAndBackslashesStayOneLiteral() {
        let text = script(account: #"A"B\C"#, source: "Ümläut/Unter", target: #"x" of account "y"#)
        #expect(text.contains(#"account "A\"B\\C""#))
        #expect(text.contains(#"mailbox "Ümläut/Unter""#))
        // Jeder Wert bleibt genau ein Literal, auch der Versuch, aus dem Literal auszubrechen.
        let found = literals(text)
        #expect(found.contains(#"A"#) == false)
        #expect(found.contains(#"A\"B\\C"#))
        #expect(found.contains(#"x\" of account \"y"#))
        #expect(found.contains(#"y"#) == false)
    }

    @Test func trailingBackslashCannotEatTheClosingQuote() {
        let text = script(account: #"evil\"#, source: #"\"#)
        let found = literals(text)
        #expect(found.contains(#"evil\\"#))
        #expect(found.contains(#"\\"#))
    }

    @Test func expectedMessageIdIsComparedBareAndInBrackets() {
        let found = literals(script(expected: #"a"b@example.com"#))
        #expect(found.contains(#"a\"b@example.com"#))
        #expect(found.contains(#"<a\"b@example.com>"#))
    }

    @Test func rowidIsDigitsOnly() throws {
        let text = script(rowid: 1234567)
        let line = try #require(lines(text).first { $0.contains("whose id is") })
        #expect(line.hasSuffix("whose id is 1234567)"))
        // Die Zahl steht ausserhalb jedes Literals und ist reine Ziffernfolge.
        #expect(literals(text).contains("1234567") == false)
    }

    @Test func scriptComparesMessageIdBeforeMoving() throws {
        let all = lines(script())
        let read = try #require(all.firstIndex { $0.contains("message id of") })
        let check = try #require(all.firstIndex { $0.hasPrefix("if mid is ") && $0.hasSuffix(" then") })
        let move = try #require(all.firstIndex { $0.hasPrefix("move ") })
        let close = try #require(all[move...].firstIndex { $0 == "end if" })
        #expect(read < check)
        #expect(check < move)
        #expect(move < close)
        // Genau ein Verschieben, und nichts oeffnet zwischen Vergleich und Verschieben einen anderen Zweig.
        #expect(all.filter { $0.hasPrefix("move ") }.count == 1)
        #expect(all[check..<move].filter { $0 == "else" || $0 == "end if" }.isEmpty)
        #expect(all[close...].contains(#"return "mismatch""#))
    }

    @Test func missingMailboxIsToldApartBeforeAnyMessageLookup() throws {
        let all = lines(script())
        let open = try #require(all.firstIndex(of: "try"))
        let handler = try #require(all.firstIndex(of: "on error number n"))
        let lookup = try #require(all.firstIndex { $0.contains("whose id is") })
        #expect(open < handler && handler < lookup)
        #expect(all[handler...].contains("if n is -1728 then return \"folder_not_found\""))
        // Fremde Nummern gehen unveraendert weiter, ohne Fehlertext.
        #expect(all[handler...].contains("error number n"))
        #expect(all[open..<handler].contains { $0.hasPrefix("set src to mailbox ") })
        #expect(all[open..<handler].contains { $0.hasPrefix("set dst to mailbox ") })
    }

    @Test func bodyRunsInsideTheTimeout() throws {
        let all = lines(script())
        #expect(all.first == "with timeout of 120 seconds")
        #expect(all.last == "end timeout")
        #expect(all[1] == #"tell application "Mail""#)
    }
}
