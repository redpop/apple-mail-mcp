import Foundation
import Testing
@testable import MailHelperCore

@Suite struct SearchTests {
    let f: Fixture
    let store: MailStore
    var all: [Int64] { f.allMailboxIds }

    init() throws {
        f = try FixtureBuilder.build()
        store = MailStore(config: f.config)
    }

    private func gids(_ r: SearchResult) -> Set<Int64> { Set(r.messages.map(\.gid)) }
    private func names(_ n: [String]) -> Set<Int64> { Set(n.map { f.gid(named: $0) }) }

    @Test func dedupesCopiesAndUnionsFlags() throws {
        let r = try store.search(.init(allowedMailboxIds: all, limit: 50))
        let m = try #require(r.messages.first { $0.gid == f.gid(named: "dup3") })
        #expect(r.messages.filter { $0.gid == m.gid }.count == 1)
        #expect(m.mailboxIds.count == 3)
        #expect(m.mailboxIds == m.mailboxIds.sorted())
        #expect(m.read && m.flagged)
        #expect(m.dateReceived == 1700000300)
        #expect(m.dateSent == 1700000240)   // beste Zeile: volle Datei vor partial (4711, Posteingang)
        #expect(m.file == .full)
    }

    @Test func excludedMailboxCopiesAreInvisible() throws {
        let noJunk = all.filter { $0 != f.mailboxId(named: "junk") }
        let r = try store.search(.init(allowedMailboxIds: noJunk, limit: 50))
        let m = try #require(r.messages.first { $0.gid == f.gid(named: "dup3") })
        #expect(m.mailboxIds.count == 2)
        #expect(!m.mailboxIds.contains(f.mailboxId(named: "junk")))
        #expect(m.dateReceived == 1700000300)
        #expect(!gids(r).contains(f.gid(named: "thread3")))   // einzige Kopie in Junk
        // Flags nur aus erlaubten Kopien: nur Junk erlaubt -> dup3 weder gelesen noch markiert.
        let junkOnly = try store.search(.init(allowedMailboxIds: [f.mailboxId(named: "junk")], limit: 50))
        let j = try #require(junkOnly.messages.first { $0.gid == f.gid(named: "dup3") })
        #expect(!j.read && !j.flagged && j.mailboxIds == [f.mailboxId(named: "junk")])
    }

    @Test func deletedNeverAppears() throws {
        let r = try store.search(.init(allowedMailboxIds: all, limit: 100))
        #expect(!gids(r).contains(f.gid(named: "deleted")))
        let byText = try store.search(.init(allowedMailboxIds: all, subject: "geloescht", limit: 10))
        #expect(byText.messages.isEmpty)
    }

    @Test func keysetPagesWithoutGapOrDuplicate() throws {
        var seen: [Int64] = []
        var after: SearchRequest.After? = nil
        repeat {
            let r = try store.search(.init(allowedMailboxIds: all, after: after, limit: 2))
            seen += r.messages.map(\.gid)
            after = r.hasMore ? .init(date: r.messages.last!.dateReceived, gid: r.messages.last!.gid) : nil
        } while after != nil
        #expect(seen.count == Set(seen).count)
        #expect(Set(seen) == f.visibleGids)
        // Reihenfolge: Datum absteigend, bei Gleichstand gid absteigend (tie1/tie2).
        let full = try store.search(.init(allowedMailboxIds: all, limit: 100))
        let keys = full.messages.map { [$0.dateReceived, $0.gid] }
        #expect(keys == keys.sorted { $0[0] != $1[0] ? $0[0] > $1[0] : $0[1] > $1[1] })
        #expect(full.hasMore == false)
    }

    @Test func hasMoreOnlyWhenMoreRemain() throws {
        let total = f.visibleGids.count
        #expect(try store.search(.init(allowedMailboxIds: all, limit: total)).hasMore == false)
        #expect(try store.search(.init(allowedMailboxIds: all, limit: total - 1)).hasMore == true)
    }

    @Test func textFiltersFoldUmlautsAndIgnoreWildcards() throws {
        #expect(gids(try store.search(.init(allowedMailboxIds: all, subject: "ärger", limit: 10))) == names(["aerger", "aerger2"]))
        #expect(gids(try store.search(.init(allowedMailboxIds: all, subject: "ÄRGER", limit: 10))) == names(["aerger", "aerger2"]))
        #expect(gids(try store.search(.init(allowedMailboxIds: all, subject: "straße", limit: 10))) == names(["strasse", "strasse2"]))
        #expect(gids(try store.search(.init(allowedMailboxIds: all, subject: "STRASSE", limit: 10))) == names(["strasse", "strasse2"]))
        #expect(try store.search(.init(allowedMailboxIds: all, subject: "arger", limit: 10)).messages.isEmpty)   // diakritiksensitiv
        // "%" ist ein woertliches Zeichen: trifft nur den Betreff mit echtem Prozentzeichen, nicht alles.
        #expect(try store.search(.init(allowedMailboxIds: all, subject: "%", limit: 10)).messages.map(\.gid) == [f.gid(named: "wildcard")])
        #expect(try store.search(.init(allowedMailboxIds: all, subject: "%%", limit: 10)).messages.isEmpty)
        #expect(try store.search(.init(allowedMailboxIds: all, subject: "100_", limit: 10)).messages.isEmpty)
        #expect(try store.search(.init(allowedMailboxIds: all, subject: "_", limit: 10)).messages.map(\.gid) == [f.gid(named: "wildcard")])
        #expect(try store.search(.init(allowedMailboxIds: all, subject: "100%", limit: 10)).messages.map(\.gid) == [f.gid(named: "wildcard")])
    }

    @Test func subjectOutputCarriesPrefix() throws {
        let m = try #require(try store.search(.init(allowedMailboxIds: all, limit: 50)).messages.first { $0.gid == f.gid(named: "thread2") })
        let seed = try #require(f.seed.messages.first { $0.name == "thread2" })
        #expect(m.subject == seed.subjectPrefix + seed.subject)
        // Filter matcht nur subjects.subject, nicht das Praefix.
        let r = try store.search(.init(allowedMailboxIds: all, subject: "projektplan", limit: 10))
        #expect(gids(r) == names(["thread1", "thread2", "thread3"]))
    }

    @Test func fromMatchesAddressAndName() throws {
        #expect(gids(try store.search(.init(allowedMailboxIds: all, from: "BILLING@", limit: 10))) == names(["invoice"]))
        #expect(gids(try store.search(.init(allowedMailboxIds: all, from: "carol", limit: 10))) == names(["allmail"]))
        let byAddress = try store.search(.init(allowedMailboxIds: all, from: "bob@example.org", limit: 10))
        #expect(gids(byAddress) == names(["tie1", "tie2"]))
        let byName = try store.search(.init(allowedMailboxIds: all, from: "BOB MUSTER", limit: 10))
        #expect(gids(byName) == names(["tie1", "tie2"]))
    }

    @Test func queryMatchesSubjectSenderAndRecipients() throws {
        #expect(gids(try store.search(.init(allowedMailboxIds: all, query: "your code", limit: 10))) == names(["otp"]))
        #expect(gids(try store.search(.init(allowedMailboxIds: all, query: "billing@example", limit: 10))) == names(["invoice"]))
        #expect(gids(try store.search(.init(allowedMailboxIds: all, query: "audit@example.net", limit: 10))) == names(["invoice"]))
        #expect(gids(try store.search(.init(allowedMailboxIds: all, query: "REVISION", limit: 10))) == names(["invoice"]))
        #expect(gids(try store.search(.init(allowedMailboxIds: all, query: "bob muster", limit: 10))) == names(["invoice", "tie1", "tie2"]))   // Empfaenger cc und Absendername
        #expect(try store.search(.init(allowedMailboxIds: all, query: "nirgendwo-vorhanden", limit: 10)).messages.isEmpty)
    }

    @Test func toMatchesAllRecipientTypes() throws {
        #expect(gids(try store.search(.init(allowedMailboxIds: all, to: "alice beispiel", limit: 10))) == names(["thread2"]))   // to
        #expect(gids(try store.search(.init(allowedMailboxIds: all, to: "bob muster", limit: 10))) == names(["invoice"]))       // cc
        #expect(gids(try store.search(.init(allowedMailboxIds: all, to: "audit@example.net", limit: 10))) == names(["invoice"])) // bcc
    }

    @Test func dateRangeIsInclusiveExclusive() throws {
        let both = try store.search(.init(allowedMailboxIds: all, since: 1700000600, before: 1700000601, limit: 10))
        #expect(gids(both) == names(["tie1", "tie2"]))
        let beforeExcl = try store.search(.init(allowedMailboxIds: all, since: 1700000400, before: 1700000600, limit: 10))
        #expect(gids(beforeExcl) == names(["noHeader"]))   // 400 inklusive, 600 exklusiv
        let none = try store.search(.init(allowedMailboxIds: all, since: 1700000601, before: 1700000700, limit: 10))
        #expect(none.messages.isEmpty)
    }

    @Test func flagFilters() throws {
        let dup = f.gid(named: "dup3")
        // dup3: eine Kopie gelesen, eine markiert.
        let unreadTrue = try store.search(.init(allowedMailboxIds: all, unread: true, limit: 100))
        #expect(!gids(unreadTrue).contains(dup))
        #expect(!gids(unreadTrue).contains(f.gid(named: "small")))
        #expect(gids(unreadTrue).contains(f.gid(named: "otp")))
        let unreadFalse = try store.search(.init(allowedMailboxIds: all, unread: false, limit: 100))
        #expect(gids(unreadFalse) == names(["dup3", "small", "thread1"]))
        let flaggedTrue = try store.search(.init(allowedMailboxIds: all, flagged: true, limit: 100))
        #expect(gids(flaggedTrue) == names(["dup3"]))
        let flaggedFalse = try store.search(.init(allowedMailboxIds: all, flagged: false, limit: 100))
        #expect(!gids(flaggedFalse).contains(dup) && flaggedFalse.messages.count == f.visibleGids.count - 1)
        // Flags zaehlen nur in erlaubten Mailboxen: ohne Archiv/Inbox ist dup3 (Junk) ungelesen und unmarkiert.
        let junk = try store.search(.init(allowedMailboxIds: [f.mailboxId(named: "junk")], unread: true, limit: 100))
        #expect(gids(junk).contains(dup))
    }

    @Test func attachmentAndMailboxFilters() throws {
        #expect(gids(try store.search(.init(allowedMailboxIds: all, hasAttachment: true, limit: 10))) == names(["invoice"]))
        #expect(!gids(try store.search(.init(allowedMailboxIds: all, hasAttachment: false, limit: 100))).contains(f.gid(named: "invoice")))
        let aerger = try store.search(.init(allowedMailboxIds: all, mailboxIds: [f.mailboxId(named: "aerger")], limit: 10))
        #expect(gids(aerger) == names(["aerger", "aerger2", "aerger3"]))
        // mailboxIds grenzt nur ein; Zeile zeigt weiter alle erlaubten Mailboxen und das Gruppendatum.
        let viaArchiv = try store.search(.init(allowedMailboxIds: all, mailboxIds: [f.mailboxId(named: "archiv2024")], limit: 10))
        let m = try #require(viaArchiv.messages.first)
        #expect(m.gid == f.gid(named: "dup3") && m.mailboxIds.count == 3 && m.dateReceived == 1700000300)
    }

    @Test func rowDetailsRecipientsAttachmentsAndSender() throws {
        let inv = try #require(try store.search(.init(allowedMailboxIds: all, limit: 50, maxRecipients: 2)).messages.first { $0.gid == f.gid(named: "invoice") })
        #expect(inv.recipientCount == 3)
        #expect(inv.recipients.map(\.type) == [.to, .cc])
        #expect(inv.recipients.first?.name == "Anna Tester")
        #expect(inv.attachmentCount == 2 && inv.attachmentNames.count == 2)
        #expect(inv.sender?.address == "billing@example.org")
        let seed = try #require(f.seed.messages.first { $0.name == "invoice" })
        #expect(inv.attachmentNames == seed.attachments)
        let zero = try #require(try store.search(.init(allowedMailboxIds: all, limit: 50, maxRecipients: 0)).messages.first { $0.gid == f.gid(named: "invoice") })
        #expect(zero.recipients.isEmpty && zero.recipientCount == 3)
        let all3 = try #require(try store.search(.init(allowedMailboxIds: all, limit: 50, maxRecipients: 10)).messages.first { $0.gid == f.gid(named: "invoice") })
        #expect(all3.recipients.map(\.type) == [.to, .cc, .bcc])
        #expect(all3.recipients.last?.name == "Revision")
        let thread = try #require(try store.search(.init(allowedMailboxIds: all, limit: 50)).messages.first { $0.gid == f.gid(named: "thread1") })
        #expect(thread.conversationId == 77)
        #expect(thread.messageIdHeader == "<thread1-1007@example.com>")
    }

    @Test func attachmentNamesAreCappedAtTwenty() throws {
        let f2 = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f2.envelopeIndex.path)
        let rowid = try #require(f2.seed.messages.first { $0.name == "small" }?.rowid)
        for i in 0..<25 {
            try h.run("INSERT INTO attachments (message, attachment_id, name) VALUES (?, ?, ?)", [.int(rowid), .text("x\(i)"), .text("a\(i).pdf")])
        }
        let m = try #require(try MailStore(config: f2.config).search(.init(allowedMailboxIds: f2.allMailboxIds, limit: 50))
            .messages.first { $0.gid == f2.gid(named: "small") })
        #expect(m.attachmentNames.count == 20 && m.attachmentCount == 25)
    }

    @Test func totalMatchedIsExactOnTheFirstPageOnly() throws {
        let small = try store.search(.init(allowedMailboxIds: all, limit: 1, countTotal: true))
        #expect(small.totalMatched == f.visibleGids.count && small.totalMatchedCapped == false)
        let off = try store.search(.init(allowedMailboxIds: all, limit: 1))
        #expect(off.totalMatched == nil && off.totalMatchedCapped == nil)
        let filtered = try store.search(.init(allowedMailboxIds: all, subject: "projektplan", limit: 1, countTotal: true))
        #expect(filtered.totalMatched == 3 && filtered.hasMore)
        let none = try store.search(.init(allowedMailboxIds: all, subject: "nirgendwo-vorhanden", limit: 5, countTotal: true))
        #expect(none.messages.isEmpty && none.totalMatched == 0 && none.totalMatchedCapped == false)
        // Folgeseiten zaehlen nicht: beide Felder fehlen.
        let m = try #require(small.messages.first)
        let next = try store.search(.init(allowedMailboxIds: all, after: .init(date: m.dateReceived, gid: m.gid), limit: 1, countTotal: true))
        #expect(next.totalMatched == nil && next.totalMatchedCapped == nil && !next.messages.isEmpty)

        // Keine Obergrenze mehr: ueber 10000 wird exakt gezaehlt.
        let big = try FixtureBuilder.build(extraMessages: 10_005)
        let r = try MailStore(config: big.config).search(.init(allowedMailboxIds: big.allMailboxIds, limit: 1, countTotal: true))
        #expect(r.totalMatched == big.visibleGids.count + 10_005 && r.totalMatchedCapped == false)
    }

    @Test func foldCacheSeesDictionaryRowsAddedLater() throws {
        let f2 = try FixtureBuilder.build()
        let s = MailStore(config: f2.config)
        let ids = f2.allMailboxIds
        // Erste Textsuche fuellt den Cache.
        #expect(try s.search(.init(allowedMailboxIds: ids, subject: "nachzuegler", limit: 10)).messages.isEmpty)
        #expect(try s.search(.init(allowedMailboxIds: ids, from: "spaet@example.net", limit: 10)).messages.isEmpty)
        // Mail haengt neue Woerterbuchzeilen an und verweist eine bestehende Nachricht darauf.
        let h = try SQLiteHandle(path: f2.envelopeIndex.path)
        let rowid = try #require(f2.seed.messages.first { $0.name == "small" }?.rowid)
        try h.run("INSERT INTO subjects (subject) VALUES (?)", [.text("Später Nachzügler")])
        let subj = h.lastInsertRowid()
        try h.run("INSERT INTO addresses (address, comment) VALUES (?, ?)", [.text("spaet@example.net"), .text("Spät Sender")])
        let addr = h.lastInsertRowid()
        try h.run("UPDATE messages SET subject = ?, sender = ? WHERE ROWID = ?", [.int(subj), .int(addr), .int(rowid)])
        try h.run("INSERT INTO recipients (message, address, type, position) VALUES (?, ?, 0, 9)", [.int(rowid), .int(addr)])
        let small = f2.gid(named: "small")
        #expect(gids(try s.search(.init(allowedMailboxIds: ids, subject: "NACHZÜGLER", limit: 10))) == [small])
        #expect(gids(try s.search(.init(allowedMailboxIds: ids, from: "spät sender", limit: 10))) == [small])
        #expect(gids(try s.search(.init(allowedMailboxIds: ids, to: "spaet@example.net", limit: 10))) == [small])
        #expect(gids(try s.search(.init(allowedMailboxIds: ids, query: "später", limit: 10))) == [small])
    }

    /// Mail legt den Index neu an: gleiche ROWIDs in `subjects` tragen andere Texte. Der Fold-Cache der alten
    /// Verbindung kennte diese ROWIDs schon und faltete sie nie neu; nach dem Neuoeffnen zaehlen die neuen Texte.
    @Test func foldCacheIsRebuiltWhenTheIndexFileIsReplaced() throws {
        let f2 = try FixtureBuilder.build()
        let s = MailStore(config: f2.config)
        let ids = f2.allMailboxIds
        let thread = names(["thread1", "thread2", "thread3"])
        #expect(try gids(s.search(.init(allowedMailboxIds: ids, subject: "projektplan", limit: 10))) == thread)
        #expect(try s.search(.init(allowedMailboxIds: ids, subject: "neubauindex", limit: 10)).messages.isEmpty)

        let rebuilt = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: rebuilt.envelopeIndex.path)
        try h.exec("""
            UPDATE subjects SET subject = 'Neubauindex ' || ROWID
            WHERE ROWID IN (SELECT subject FROM messages WHERE global_message_id IN (\(thread.map(String.init).joined(separator: ","))))
            """)
        try FileManager.default.removeItem(at: f2.envelopeIndex)
        try FileManager.default.copyItem(at: rebuilt.envelopeIndex, to: f2.envelopeIndex)

        #expect(try s.search(.init(allowedMailboxIds: ids, subject: "projektplan", limit: 10)).messages.isEmpty)
        #expect(try gids(s.search(.init(allowedMailboxIds: ids, subject: "neubauindex", limit: 10))) == thread)
        #expect(try gids(s.search(.init(allowedMailboxIds: ids, query: "NEUBAUINDEX", limit: 10))) == thread)
    }

    @Test func searchWritesNothingToTheEnvelopeIndex() throws {
        let f2 = try FixtureBuilder.build()
        let path = f2.envelopeIndex.path
        let before = try Data(contentsOf: f2.envelopeIndex)
        let s = MailStore(config: f2.config)
        _ = try s.search(.init(allowedMailboxIds: f2.allMailboxIds, subject: "projektplan", limit: 10, countTotal: true))
        _ = try s.search(.init(allowedMailboxIds: f2.allMailboxIds, query: "bob", limit: 10, countTotal: true))
        #expect(try Data(contentsOf: f2.envelopeIndex) == before)
        let dir = f2.envelopeIndex.deletingLastPathComponent()
        let siblings = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix(f2.envelopeIndex.lastPathComponent) }
        #expect(siblings == [f2.envelopeIndex.lastPathComponent], "\(path)")
    }

    /// Wie bei Mail: ein Schreiber haelt den Index im WAL-Modus offen, die letzte Aenderung steht nur im
    /// `-wal`. Die Lesekommandos sehen sie und aendern weder die Hauptdatei noch das `-wal`. Die `-shm`
    /// aendert sich (Lesemarken der Verbindung); sie ist ein Index des WAL, keine Mail-Daten.
    @Test func readCommandsInWalModeWriteNeitherMainFileNorWal() throws {
        let f2 = try FixtureBuilder.build()
        let writer = try SQLiteHandle(path: f2.envelopeIndex.path)
        try writer.exec("PRAGMA journal_mode = WAL")
        try writer.exec("PRAGMA wal_autocheckpoint = 0")
        let small = try #require(f2.seed.messages.first { $0.name == "small" })
        try writer.run("UPDATE subjects SET subject = 'Nur im Wal' WHERE ROWID = (SELECT subject FROM messages WHERE ROWID = ?)",
                       [.int(small.rowid)])
        let wal = URL(fileURLWithPath: f2.envelopeIndex.path + "-wal")
        let mainBefore = try Data(contentsOf: f2.envelopeIndex)
        let walBefore = try Data(contentsOf: wal)
        #expect(!walBefore.isEmpty)

        do {
            let s = MailStore(config: f2.config)
            let ids = f2.allMailboxIds
            let hit = try s.search(.init(allowedMailboxIds: ids, subject: "nur im wal", limit: 10, countTotal: true))
            #expect(hit.messages.map(\.gid) == [small.gid] && hit.totalMatched == 1)
            _ = try s.search(.init(allowedMailboxIds: ids, query: "bob", hasAttachment: true, limit: 10, countTotal: true))
            _ = try s.listMailboxes()
            _ = try s.thread(.init(allowedMailboxIds: ids, gid: f2.gid(named: "thread1"), limit: 10, maxRecipients: 5))
            _ = try s.getMessages(.init(allowedMailboxIds: ids, gids: [small.gid], maxBytesPerMessage: 1 << 20, maxBytesTotal: 1 << 20))
        }   // Store und Verbindung sind hier freigegeben: auch das Schliessen schreibt nichts.
        #expect(try Data(contentsOf: f2.envelopeIndex) == mainBefore)
        #expect(try Data(contentsOf: wal) == walBefore)
    }

    @Test func pageOnTenThousandRowsIsFast() throws {
        let big = try FixtureBuilder.build(extraMessages: 10_000)
        let s = MailStore(config: big.config)
        _ = try s.search(.init(allowedMailboxIds: big.allMailboxIds, limit: 1))   // Verbindung oeffnen
        let t0 = ContinuousClock.now
        let r = try s.search(.init(allowedMailboxIds: big.allMailboxIds, limit: 20, countTotal: true))
        let elapsed = ContinuousClock.now - t0
        print("search page over 10000 extra rows: \(elapsed)")
        #expect(r.messages.count == 20 && r.hasMore)
        #expect(elapsed < .seconds(2))
    }

    @Test func filteredPagesOnTenThousandRowsAreFast() throws {
        let big = try FixtureBuilder.build(extraMessages: 10_000)
        let s = MailStore(config: big.config)
        let ids = big.allMailboxIds
        _ = try s.search(.init(allowedMailboxIds: ids, limit: 1))
        let cases: [(String, SearchRequest, Int)] = [
            ("subject", .init(allowedMailboxIds: ids, subject: "thema 17", limit: 20, countTotal: true), 20),
            ("from", .init(allowedMailboxIds: ids, from: "ABSENDER 42", limit: 20, countTotal: true), 20),
            ("to", .init(allowedMailboxIds: ids, to: "empfaenger7@", limit: 20, countTotal: true), 20),
            ("query", .init(allowedMailboxIds: ids, query: "empfaenger 123", limit: 20, countTotal: true), 20),
        ]
        for (name, req, _) in cases {
            let t0 = ContinuousClock.now
            let r = try s.search(req)
            let elapsed = ContinuousClock.now - t0
            print("filtered search \(name): \(elapsed)")
            #expect(!r.messages.isEmpty, "\(name)")
            #expect(r.totalMatched == r.messages.count || r.hasMore, "\(name)")
            #expect(elapsed < .milliseconds(500), "\(name)")
        }
        // Zahlen stimmen: "thema 17" trifft Thema 17 und 170-179 (11 Betreffs) mit je 20 Zeilen.
        let r = try s.search(.init(allowedMailboxIds: ids, subject: "thema 17", limit: 1000, countTotal: true))
        #expect(r.totalMatched == 220 && r.messages.count == 220)
    }

    /// Warme Seiten (Spec 18: unter 200 ms je Seite bei warmem Helper) auf 50000 Nachrichten mit
    /// vielfaeltigen Woerterbuechern. Debug-Build, daher die engere Grenze 150 ms als Puffer fuer Release.
    @Test func warmPagesOnFiftyThousandVariedRowsAreFast() throws {
        let big = try FixtureBuilder.build(extraMessages: 50_000, bulk: .varied)
        let s = MailStore(config: big.config)
        let ids = big.allMailboxIds
        func page(_ r: SearchRequest) -> SearchRequest {
            var r = r
            r.limit = 20
            r.countTotal = true
            return r
        }
        let cases: [(name: String, req: SearchRequest, asserted: Bool)] = [
            ("no filter", page(.init(allowedMailboxIds: ids, limit: 20)), true),
            ("subject", page(.init(allowedMailboxIds: ids, subject: "straße nr. 12", limit: 20)), true),
            ("from", page(.init(allowedMailboxIds: ids, from: "GRÖSSE 4", limit: 20)), true),
            ("to", page(.init(allowedMailboxIds: ids, to: "jürgen 3", limit: 20)), true),
            ("query", page(.init(allowedMailboxIds: ids, query: "thema 42", limit: 20)), true),
            ("unread", page(.init(allowedMailboxIds: ids, unread: true, limit: 20)), false),
            ("hasAttachment", page(.init(allowedMailboxIds: ids, hasAttachment: true, limit: 20)), false),
        ]
        for c in cases {
            let first = try s.search(c.req)   // warm: Verbindung und gefaltete Woerterbuecher
            var durations: [Duration] = []
            for _ in 0..<5 {
                let t0 = ContinuousClock.now
                let r = try s.search(c.req)
                durations.append(ContinuousClock.now - t0)
                #expect(r == first, "\(c.name)")
            }
            let median = durations.sorted()[2]
            print("warm search on 50000 varied rows, \(c.name): median \(median), total \(first.totalMatched ?? -1)")
            #expect(first.messages.count == 20 && first.hasMore, "\(c.name)")
            if c.asserted { #expect(median < .milliseconds(150), "\(c.name)") }
        }
    }

    @Test func foldAsciiFastPathEqualsGeneralPath() {
        for s in ["Hello World", "ABC xyz 123 %_", "", "Re: Rechnung 2024-0815"] {
            #expect(fold(s) == s.lowercased().precomposedStringWithCanonicalMapping.replacingOccurrences(of: "ß", with: "ss"))
        }
        #expect(fold("Straße ÄRGER") == "strasse ärger")
    }

    @Test func mailboxIdsOutsideAllowedIsInvalidInput() throws {
        let allowed = [f.mailboxId(named: "inbox")]
        do {
            _ = try store.search(.init(allowedMailboxIds: allowed, mailboxIds: [f.mailboxId(named: "junk")], limit: 10))
            Issue.record("expected failure")
        } catch {
            #expect(error.code == .invalidInput)
            #expect(error.message.contains("mailboxIds"))
            #expect(!error.message.contains("\(f.mailboxId(named: "junk"))"))
        }
        #expect(throws: HelperFailure.self) { try store.search(.init(allowedMailboxIds: allowed, mailboxIds: [], limit: 10)) }
    }

    @Test func emptyAllowedIsInvalidInput() throws {
        do {
            _ = try store.search(.init(allowedMailboxIds: [], limit: 10))
            Issue.record("expected failure")
        } catch {
            #expect(error.code == .invalidInput)
        }
    }

    @Test func limitAndMaxRecipientsAreValidated() throws {
        for limit in [0, 2001, -1] {
            do {
                _ = try store.search(.init(allowedMailboxIds: all, limit: limit))
                Issue.record("expected failure")
            } catch { #expect(error.code == .invalidInput && error.message.contains("limit")) }
        }
        do {
            _ = try store.search(.init(allowedMailboxIds: all, limit: 5, maxRecipients: -1))
            Issue.record("expected failure")
        } catch { #expect(error.code == .invalidInput && error.message.contains("maxRecipients")) }
        #expect((try store.search(.init(allowedMailboxIds: all, limit: 2000))).messages.count == f.visibleGids.count)
    }

    @Test func messageWithoutHeaderSenderOrSubject() throws {
        let r = try store.search(.init(allowedMailboxIds: all, limit: 100))
        let m = try #require(r.messages.first { $0.gid == f.gid(named: "noHeader") })
        #expect(m.messageIdHeader == nil); #expect(m.sender == nil); #expect(m.subject == "")
        // Alle drei Speicherformen "kein Absender" bleiben im Ergebnis und liefern sender == nil.
        for n in ["lokal", "senderDangling"] {
            let x = try #require(r.messages.first { $0.gid == f.gid(named: n) })
            #expect(x.sender == nil)
        }
    }

    @Test func nullSenderStorageDoesNotDropMessage() throws {
        let f2 = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f2.envelopeIndex.path)
        try h.run("UPDATE messages SET sender = NULL WHERE ROWID = ?", [.int(f2.seed.messages.first { $0.name == "small" }!.rowid)])
        let r = try MailStore(config: f2.config).search(.init(allowedMailboxIds: f2.allMailboxIds, limit: 100))
        let m = try #require(r.messages.first { $0.gid == f2.gid(named: "small") })
        #expect(m.sender == nil)
    }

    @Test func jsonShapeMatchesContract() throws {
        let r = try store.search(.init(allowedMailboxIds: all, limit: 100, countTotal: true))
        let data = try JSONEncoder().encode(r)
        let obj = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rows = try #require(obj["messages"] as? [[String: Any]])
        let nh = try #require(rows.first { ($0["gid"] as? Int64) == f.gid(named: "noHeader") })
        #expect(nh["messageIdHeader"] is NSNull && nh["sender"] is NSNull)
        #expect(Set(nh.keys) == ["gid", "messageIdHeader", "subject", "sender", "recipients", "recipientCount", "dateReceived",
                                 "dateSent", "mailboxIds", "read", "flagged", "attachmentNames", "attachmentCount", "conversationId", "file"])
        #expect(obj["totalMatched"] != nil && obj["totalMatchedCapped"] as? Bool == false)
        let req = try JSONDecoder().decode(SearchRequest.self, from: Data(#"{"allowedMailboxIds":[1],"after":{"date":5,"gid":6},"limit":3,"maxRecipients":2,"countTotal":true}"#.utf8))
        #expect(req.after == .init(date: 5, gid: 6) && req.limit == 3 && req.countTotal)
    }
}
