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

    @Test func threadJSONHasNullConversationId() throws {
        let enc = JSONEncoder()
        let single = try String(decoding: enc.encode(store.thread(request("small", allowed: f.allMailboxIds))), as: UTF8.self)
        #expect(single.contains(#""conversationId":null"#))
    }
}
