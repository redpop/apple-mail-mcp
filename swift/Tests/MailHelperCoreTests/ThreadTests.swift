import Foundation
import Testing
@testable import MailHelperCore

@Suite struct ThreadTests {
    let f: Fixture
    let store: MailStore

    init() throws {
        f = try FixtureBuilder.build()
        store = MailStore(config: f.config)
    }

    private func request(_ name: String, allowed: [Int64], limit: Int = 50) -> ThreadRequest {
        .init(allowedMailboxIds: allowed, gid: f.gid(named: name), limit: limit, maxRecipients: 5)
    }

    @Test func threadIsAscendingDedupedAndPolicyBound() throws {
        let noJunk = f.allMailboxIds.filter { $0 != f.mailboxId(named: "junk") }
        let t = try store.thread(request("thread2", allowed: noJunk))
        #expect(t.conversationId == 77)
        #expect(t.messages.map(\.gid) == [f.gid(named: "thread1"), f.gid(named: "thread2")])
        #expect(t.messages.map(\.dateReceived) == t.messages.map(\.dateReceived).sorted())
        #expect(!t.hasMore)
        // Mit Junk erlaubt: alle drei, aufsteigend.
        let all = try store.thread(request("thread1", allowed: f.allMailboxIds))
        #expect(all.messages.map(\.gid) == ["thread1", "thread2", "thread3"].map { f.gid(named: $0) })
    }

    @Test func threadLimitKeepsOldestAndSetsHasMore() throws {
        let t = try store.thread(request("thread3", allowed: f.allMailboxIds, limit: 2))
        #expect(t.messages.map(\.gid) == [f.gid(named: "thread1"), f.gid(named: "thread2")])
        #expect(t.hasMore)
        let exact = try store.thread(request("thread3", allowed: f.allMailboxIds, limit: 3))
        #expect(exact.messages.count == 3 && !exact.hasMore)
    }

    @Test func threadOfConversationZeroIsSingle() throws {
        let t = try store.thread(request("small", allowed: f.allMailboxIds))
        #expect(t.conversationId == nil)
        #expect(t.messages.map(\.gid) == [f.gid(named: "small")])
        #expect(!t.hasMore)
    }

    @Test func threadUnknownGidIsNotFound() throws {
        for r in [ThreadRequest(allowedMailboxIds: f.allMailboxIds, gid: 999_999, limit: 10, maxRecipients: 5),
                  request("deleted", allowed: f.allMailboxIds),                       // nur geloeschte Kopie
                  request("thread3", allowed: [f.mailboxId(named: "inbox")])] {      // nur in nicht erlaubter Mailbox
            do {
                _ = try store.thread(r)
                Issue.record("expected MESSAGE_NOT_FOUND")
            } catch {
                #expect(error.code == .messageNotFound)
            }
        }
    }

    @Test func threadValidatesInput() throws {
        for r in [ThreadRequest(allowedMailboxIds: [], gid: 1, limit: 10, maxRecipients: 5),
                  request("small", allowed: f.allMailboxIds, limit: 0),
                  request("small", allowed: f.allMailboxIds, limit: 101),
                  ThreadRequest(allowedMailboxIds: f.allMailboxIds, gid: 1, limit: 10, maxRecipients: -1)] {
            do {
                _ = try store.thread(r)
                Issue.record("expected INVALID_INPUT")
            } catch {
                #expect(error.code == .invalidInput)
            }
        }
    }

    private static func copy(gid: Int64, rowid: Int64, mailbox: String, date: Int64, deleted: Bool = false) -> Seed.Message {
        Seed.Message(
            name: "conv\(rowid)", gid: gid, rowid: rowid, mailbox: mailbox, subjectPrefix: "", subject: "Konversation \(gid)",
            sender: .init(address: "konv@example.com", comment: "Konv"), recipients: [],
            dateReceived: date, dateSent: date - 60, read: true, flagged: false, deleted: deleted,
            conversationId: 99, messageIdHeader: "<conv-\(gid)@example.com>", attachments: [], file: "full",
            storeIndex: 0, senderStored: nil, emlx: nil, body: "Synthetischer Text.\n")
    }

    /// Eine Konversation mit mehreren Kopien je gid und geloeschten Kopien: 3201 liegt zweimal vor (die
    /// juengere Kopie im Archiv bestimmt das Gruppendatum), 3202 hat eine juengere geloeschte Kopie, die das
    /// Datum nicht verschieben darf, 3203 existiert nur geloescht und fehlt.
    @Test func threadGroupsCopiesAndIgnoresDeletedOnes() throws {
        let f = try FixtureBuilder.build(extraSeedMessages: [
            Self.copy(gid: 3201, rowid: 9201, mailbox: "inbox", date: 1_700_003_000),
            Self.copy(gid: 3201, rowid: 9202, mailbox: "archiv2024", date: 1_700_003_500),
            Self.copy(gid: 3202, rowid: 9203, mailbox: "inbox", date: 1_700_003_200),
            Self.copy(gid: 3202, rowid: 9204, mailbox: "inbox", date: 1_700_003_900, deleted: true),
            Self.copy(gid: 3203, rowid: 9205, mailbox: "inbox", date: 1_700_003_100, deleted: true),
            Self.copy(gid: 3204, rowid: 9206, mailbox: "inbox", date: 1_700_003_300),
        ])
        let s = MailStore(config: f.config)
        let t = try s.thread(.init(allowedMailboxIds: f.allMailboxIds, gid: 3201, limit: 10, maxRecipients: 5))
        #expect(t.conversationId == 99 && !t.hasMore)
        #expect(t.messages.map(\.gid) == [3202, 3204, 3201])
        #expect(t.messages.map(\.dateReceived) == [1_700_003_200, 1_700_003_300, 1_700_003_500])
        let multi = try #require(t.messages.last)
        #expect(multi.mailboxIds == [f.mailboxId(named: "inbox"), f.mailboxId(named: "archiv2024")].sorted())
        // Ohne Archiv faellt die juengere Kopie weg; 3201 rueckt nach vorn.
        let noArchive = f.allMailboxIds.filter { $0 != f.mailboxId(named: "archiv2024") }
        let t2 = try s.thread(.init(allowedMailboxIds: noArchive, gid: 3204, limit: 10, maxRecipients: 5))
        #expect(t2.messages.map(\.gid) == [3201, 3202, 3204])
        let page = try s.thread(.init(allowedMailboxIds: f.allMailboxIds, gid: 3204, limit: 2, maxRecipients: 5))
        #expect(page.messages.map(\.gid) == [3202, 3204] && page.hasMore)
        do {
            _ = try s.thread(.init(allowedMailboxIds: f.allMailboxIds, gid: 3203, limit: 10, maxRecipients: 5))
            Issue.record("expected MESSAGE_NOT_FOUND")
        } catch {
            #expect(error.code == .messageNotFound)
        }
    }

    @Test func threadJSONHasNullConversationId() throws {
        let enc = JSONEncoder()
        let single = try String(decoding: enc.encode(store.thread(request("small", allowed: f.allMailboxIds))), as: UTF8.self)
        #expect(single.contains(#""conversationId":null"#))
    }
}
