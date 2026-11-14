import Foundation
import Testing
@testable import MailHelperCore

/// `locate`: aktuelle ROWIDs der sichtbaren Kopien je gid (Vorarbeit fuer das Verschieben).
@Suite struct LocateTests {
    let f: Fixture
    let store: MailStore
    var all: [Int64] { f.allMailboxIds }

    init() throws {
        f = try FixtureBuilder.build()
        store = MailStore(config: f.config)
    }

    @Test func locateReturnsAllVisibleCopies() throws {
        let gid = f.gid(named: "dup3")
        let r = try store.locate(.init(allowedMailboxIds: all, gids: [gid]))
        let m = try #require(r.messages.first)
        #expect(r.messages.count == 1 && m.gid == gid)
        #expect(m.copies.map(\.rowid) == [123456, 4712, 4711])    // ROWID absteigend
        #expect(Set(m.copies.map(\.mailboxId)) == Set([f.mailboxId(named: "inbox"), f.mailboxId(named: "archiv2024"),
                                                       f.mailboxId(named: "junk")]))
        #expect(m.messageIdHeader == "<dup3-1001@example.com>")
        #expect(m.subject == "Dreifach vorhanden")
        #expect(m.fromAddress == "alice@example.com")
    }

    @Test func locateHidesCopiesOutsideAllowed() throws {
        let inbox = f.mailboxId(named: "inbox")
        let r = try store.locate(.init(allowedMailboxIds: [inbox], gids: [f.gid(named: "dup3")]))
        #expect(r.messages.first?.copies.map(\.rowid) == [4711])
        // gid nur ausserhalb von allowed: fehlt ganz.
        let none = try store.locate(.init(allowedMailboxIds: [inbox], gids: [f.gid(named: "thread3")]))
        #expect(none.messages.isEmpty)
    }

    @Test func locateSkipsDeletedRows() throws {
        let r = try store.locate(.init(allowedMailboxIds: all, gids: [f.gid(named: "deleted")]))
        #expect(r.messages.isEmpty)
    }

    @Test func locateRejectsMoreThan100Gids() {
        let gids = (1...101).map { Int64($0) }
        #expect(throws: HelperFailure.self) { try store.locate(.init(allowedMailboxIds: all, gids: gids)) }
        do { _ = try store.locate(.init(allowedMailboxIds: all, gids: gids)) } catch { #expect(error.code == .invalidInput) }
        #expect(throws: HelperFailure.self) { try store.locate(.init(allowedMailboxIds: all, gids: [])) }
    }

    @Test func locateRejectsEmptyAllowed() {
        do { _ = try store.locate(.init(allowedMailboxIds: [], gids: [1])); Issue.record("kein Fehler") }
        catch { #expect(error.code == .invalidInput) }
    }

    @Test func locateOmitsUnknownGid() throws {
        let known = f.gid(named: "invoice")
        let r = try store.locate(.init(allowedMailboxIds: all, gids: [999_999, known]))
        #expect(r.messages.map(\.gid) == [known])
        #expect(r.messages[0].copies.count == 1)
    }

    @Test func locateHandlesMissingHeaderAndSender() throws {
        let r = try store.locate(.init(allowedMailboxIds: all, gids: [f.gid(named: "noHeader"), f.gid(named: "senderDangling")]))
        #expect(r.messages.count == 2)
        #expect(r.messages[0].messageIdHeader == nil && r.messages[0].fromAddress == nil)
        #expect(r.messages[1].fromAddress == nil)
    }

    @Test func locateKeepsSubjectPrefix() throws {
        let r = try store.locate(.init(allowedMailboxIds: all, gids: [f.gid(named: "thread2")]))
        #expect(r.messages.first?.subject == "Re: Re: Projektplan")
    }

    // withAttachments: Teilkennungen je Kopie (Teil von Mails Attachment-Id), nur auf Anfrage.
    @Test func locateWithoutAttachmentsUnchanged() throws {
        let r = try store.locate(.init(allowedMailboxIds: all, gids: [f.gid(named: "dup3")]))
        #expect(r.messages[0].copies.allSatisfy { $0.attachments == nil })
        let json = try String(decoding: JSONEncoder().encode(r), as: UTF8.self)
        #expect(!json.contains("attachments"))
    }

    @Test func locateWithAttachmentsListsPartIdsPerCopy() throws {
        let f2 = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f2.envelopeIndex.path)
        let rowid = try #require(f2.seed.messages.first { $0.name == "small" }?.rowid)
        try h.run("INSERT INTO attachments (message, attachment_id, name) VALUES (?, '2', 'rechnung.pdf')", [.int(rowid)])
        try h.run("INSERT INTO attachments (message, attachment_id, name) VALUES (?, '3', 'lieferschein.pdf')", [.int(rowid)])
        let r = try MailStore(config: f2.config).locate(
            .init(allowedMailboxIds: f2.allMailboxIds, gids: [f2.gid(named: "small")], withAttachments: true))
        let copy = try #require(r.messages.first?.copies.first)
        #expect(copy.attachments == [.init(partId: "2", name: "rechnung.pdf"), .init(partId: "3", name: "lieferschein.pdf")])
        // Kopie ohne Anhaenge: leere Liste, nicht nil.
        let none = try MailStore(config: f2.config).locate(
            .init(allowedMailboxIds: f2.allMailboxIds, gids: [f2.gid(named: "dup3")], withAttachments: true))
        #expect(none.messages[0].copies.allSatisfy { $0.attachments == [] })
    }

    @Test func locateAttachmentsCappedAt20() throws {
        let f2 = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f2.envelopeIndex.path)
        let rowid = try #require(f2.seed.messages.first { $0.name == "small" }?.rowid)
        for i in 0..<25 {
            try h.run("INSERT INTO attachments (message, attachment_id, name) VALUES (?, ?, ?)", [.int(rowid), .text("\(i + 1)"), .text("a\(i).pdf")])
        }
        let r = try MailStore(config: f2.config).locate(
            .init(allowedMailboxIds: f2.allMailboxIds, gids: [f2.gid(named: "small")], withAttachments: true))
        let list = try #require(r.messages.first?.copies.first?.attachments)
        #expect(list.count == 20 && list.first?.name == "a0.pdf" && list.last?.name == "a19.pdf")
    }
}
