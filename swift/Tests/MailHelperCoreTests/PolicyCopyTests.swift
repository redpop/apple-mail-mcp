import Foundation
import Testing
@testable import MailHelperCore

/// Eine gid mit drei Kopien, die sich in Betreff, Absender und Empfaenger unterscheiden: erlaubt (Posteingang),
/// in einer ausgeschlossenen Mailbox (Junk) und geloescht (Posteingang). Schuetzt die Richtlinie in den
/// Textfilter-Teilabfragen (`anyAllowedCopy`) und die Wahl der besten Zeile in `loadRows`.
@Suite struct PolicyCopyTests {
    let f: Fixture
    let store: MailStore
    var allowed: [Int64] { f.allMailboxIds.filter { $0 != f.mailboxId(named: "junk") } }
    let gid: Int64 = 3001

    private static func copy(_ name: String, rowid: Int64, mailbox: String, deleted: Bool, subject: String,
                             sender: String, recipient: String, date: Int64) -> Seed.Message {
        Seed.Message(
            name: name, gid: 3001, rowid: rowid, mailbox: mailbox, subjectPrefix: "", subject: subject,
            sender: .init(address: "\(sender)@example.com", comment: "Absender \(sender)"),
            recipients: [.init(type: 0, address: "\(recipient)@example.org", comment: "Empfaenger \(recipient)")],
            dateReceived: date, dateSent: date - 60, read: true, flagged: false, deleted: deleted,
            conversationId: 88, messageIdHeader: "<policy-3001@example.com>", attachments: [], file: "full",
            storeIndex: 0, senderStored: nil, emlx: nil, body: "Synthetischer Text fuer \(name).\n")
    }

    init() throws {
        f = try FixtureBuilder.build(extraSeedMessages: [
            Self.copy("policyAllowed", rowid: 9001, mailbox: "inbox", deleted: false, subject: "Hauptkopie sichtbar",
                      sender: "visabsender", recipient: "visempfaenger", date: 1_700_001_000),
            // Hoehere ROWID und juengeres Datum als die erlaubte Kopie: ohne Richtlinie wuerde loadRows sie waehlen.
            Self.copy("policyJunk", rowid: 9002, mailbox: "junk", deleted: false, subject: "Verstecktjunk Betreff",
                      sender: "junkabsender", recipient: "junkempfaenger", date: 1_700_001_100),
            Self.copy("policyDeleted", rowid: 9003, mailbox: "inbox", deleted: true, subject: "Tilgkopie Betreff",
                      sender: "tilgabsender", recipient: "tilgempfaenger", date: 1_700_001_200),
        ])
        store = MailStore(config: f.config)
    }

    private func found(_ r: SearchRequest) throws -> Set<Int64> {
        Set(try store.search(r).messages.map(\.gid))
    }

    private func hidden() -> [(label: String, build: (String) -> SearchRequest)] {
        [("subject", { .init(allowedMailboxIds: allowed, subject: $0, limit: 50) }),
         ("from", { .init(allowedMailboxIds: allowed, from: $0, limit: 50) }),
         ("to", { .init(allowedMailboxIds: allowed, to: $0, limit: 50) }),
         ("query", { .init(allowedMailboxIds: allowed, query: $0, limit: 50) })]
    }

    @Test func hiddenCopyValuesNeverMatch() throws {
        let terms: [String: [String]] = [
            "subject": ["verstecktjunk", "tilgkopie"],
            "from": ["junkabsender", "tilgabsender"],
            "to": ["junkempfaenger", "tilgempfaenger"],
            "query": ["verstecktjunk", "tilgkopie", "junkabsender", "tilgabsender", "junkempfaenger", "tilgempfaenger"],
        ]
        for h in hidden() {
            for t in terms[h.label]! {
                #expect(try found(h.build(t)).isEmpty, "\(h.label) \(t)")
            }
        }
        // Mit Junk erlaubt wird die Junk-Kopie gefunden (die Filter wirken also), die geloeschte nie.
        let withJunk = f.allMailboxIds
        #expect(try found(.init(allowedMailboxIds: withJunk, subject: "verstecktjunk", limit: 50)) == [gid])
        #expect(try found(.init(allowedMailboxIds: withJunk, subject: "tilgkopie", limit: 50)).isEmpty)
    }

    @Test func allowedCopyValuesMatch() throws {
        let terms: [String: String] = ["subject": "hauptkopie", "from": "visabsender", "to": "visempfaenger"]
        for h in hidden() {
            let t = terms[h.label] ?? "visabsender"
            #expect(try found(h.build(t)) == [gid], "\(h.label) \(t)")
        }
        for t in ["hauptkopie", "visabsender", "visempfaenger"] {
            #expect(try found(.init(allowedMailboxIds: allowed, query: t, limit: 50)) == [gid], "query \(t)")
        }
    }

    @Test func rowsShowOnlyTheAllowedCopy() throws {
        let inbox = f.mailboxId(named: "inbox")
        func check(_ m: MessageRow, _ what: String) {
            #expect(m.subject == "Hauptkopie sichtbar", "\(what) subject")
            #expect(m.sender?.address == "visabsender@example.com", "\(what) sender")
            #expect(m.recipients.map(\.address) == ["visempfaenger@example.org"], "\(what) recipients")
            #expect(m.mailboxIds == [inbox], "\(what) mailboxes")
            #expect(m.dateReceived == 1_700_001_000, "\(what) date")
        }
        let s = try store.search(.init(allowedMailboxIds: allowed, subject: "hauptkopie", limit: 50, maxRecipients: 5))
        check(try #require(s.messages.first { $0.gid == gid }), "search")

        let t = try store.thread(.init(allowedMailboxIds: allowed, gid: gid, limit: 50, maxRecipients: 5))
        #expect(t.conversationId == 88)
        #expect(t.messages.map(\.gid) == [gid])
        check(t.messages[0], "thread")

        let g = try store.getMessages(.init(allowedMailboxIds: allowed, gids: [gid], maxBytesPerMessage: 1 << 20, maxBytesTotal: 1 << 20))
        #expect(g.missing.isEmpty)
        check(try #require(g.messages.first).row, "get-messages")
        let b64 = try #require(g.messages[0].raw)
        let raw = try #require(Data(base64Encoded: b64))
        let text = String(decoding: raw, as: UTF8.self)
        #expect(text.contains("policyAllowed") && !text.contains("policyJunk") && !text.contains("policyDeleted"))
    }
}
