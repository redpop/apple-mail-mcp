import Foundation
import Testing
@testable import MailHelperCore

/// Body-Index-Spec 5.3: `index-feed`, `index-gids` und `search` mit `gids` gegen die Fixture.
@Suite struct IndexFeedTests {
    let f: Fixture
    let store: MailStore
    var all: [Int64] { f.allMailboxIds }

    init() throws {
        f = try FixtureBuilder.build()
        store = MailStore(config: f.config)
    }

    /// Orakel aus dem Seed: nicht geloeschte Zeilen in erlaubten Mailboxen, nach ROWID.
    private func expectedRows(_ allowed: [Int64]) -> [IndexFeedRow] {
        f.seed.messages
            .filter { !$0.deleted && allowed.contains(f.mailboxId(named: $0.mailbox)) }
            .sorted { $0.rowid < $1.rowid }
            .map { IndexFeedRow(rowid: $0.rowid, gid: $0.gid, date: $0.dateReceived) }
    }

    // MARK: - index-feed

    @Test func feedPagesAscendingWithoutGapOrDuplicate() throws {
        var seen: [IndexFeedRow] = []
        var after: Int64 = 0
        var pages = 0
        while true {
            let r = try store.indexFeed(.init(allowedMailboxIds: all, afterRowid: after, limit: 3))
            #expect(r.rows.count <= 3)
            #expect(r.maxRowid == 123456)
            seen += r.rows
            pages += 1
            guard r.hasMore else { break }
            after = try #require(r.rows.last).rowid
        }
        #expect(seen == expectedRows(all))
        #expect(pages == (expectedRows(all).count + 2) / 3)
    }

    @Test func feedSkipsDeletedAndDisallowedMailboxes() throws {
        let noJunk = all.filter { $0 != f.mailboxId(named: "junk") }
        let r = try store.indexFeed(.init(allowedMailboxIds: noJunk, afterRowid: 0, limit: 5000))
        #expect(r.rows == expectedRows(noJunk))
        #expect(!r.rows.contains { $0.rowid == 21 })      // deleted
        #expect(!r.rows.contains { $0.rowid == 4712 })    // dup3 in Junk
        #expect(!r.rows.contains { $0.gid == f.gid(named: "thread3") })
        #expect(r.hasMore == false)
    }

    @Test func feedReportsMaxRowidOfWholeTableEvenWhenNothingIsLeft() throws {
        // Hoechste ROWID liegt in archiv2024; ohne diese Mailbox bleibt maxRowid gleich.
        let inbox = [f.mailboxId(named: "inbox")]
        let r = try store.indexFeed(.init(allowedMailboxIds: inbox, afterRowid: 123456, limit: 10))
        #expect(r.rows.isEmpty && !r.hasMore)
        #expect(r.maxRowid == 123456)
    }

    @Test func feedDateIsTheRowsOwnDate() throws {
        let r = try store.indexFeed(.init(allowedMailboxIds: all, afterRowid: 0, limit: 5000))
        let dup = r.rows.filter { $0.gid == f.gid(named: "dup3") }
        #expect(dup.map(\.date) == [1700000300, 1700000250, 1700000200])   // ROWID 4711, 4712, 123456
    }

    @Test(arguments: [0, 5001, -1])
    func feedRejectsLimitOutOfRange(_ limit: Int) {
        #expect(throws: HelperFailure.self) { try store.indexFeed(.init(allowedMailboxIds: all, afterRowid: 0, limit: limit)) }
    }

    @Test func feedRejectsEmptyAllowedAndNegativeAfter() {
        #expect(throws: HelperFailure.self) { try store.indexFeed(.init(allowedMailboxIds: [], afterRowid: 0, limit: 10)) }
        #expect(throws: HelperFailure.self) { try store.indexFeed(.init(allowedMailboxIds: all, afterRowid: -1, limit: 10)) }
    }

    // MARK: - index-gids

    @Test func gidsPagesAscendingAndMatchVisibleGids() throws {
        var seen: [IndexGidsResult.Entry] = []
        var after: Int64 = 0
        while true {
            let r = try store.indexGids(.init(allowedMailboxIds: all, afterGid: after, limit: 4))
            #expect(r.gids.count <= 4)
            seen += r.gids
            guard r.hasMore else { break }
            after = try #require(r.gids.last).gid
        }
        #expect(seen.map(\.gid) == f.visibleGids.sorted())
    }

    @Test func gidsHasFileFollowsAnyCopy() throws {
        let r = try store.indexGids(.init(allowedMailboxIds: all, afterGid: 0, limit: 20000))
        let byGid = Dictionary(uniqueKeysWithValues: r.gids.map { ($0.gid, $0.hasFile) })
        #expect(byGid[f.gid(named: "small")] == true)
        #expect(byGid[f.gid(named: "trash")] == false)       // keine Datei
        #expect(byGid[f.gid(named: "dup3")] == true)
        // dup3 nur in Junk erlaubt: diese Kopie hat keine Datei.
        let junk = try store.indexGids(.init(allowedMailboxIds: [f.mailboxId(named: "junk")], afterGid: 0, limit: 100))
        #expect(junk.gids.first { $0.gid == f.gid(named: "dup3") }?.hasFile == false)
        // dup3 nur in archiv2024: .partial.emlx zaehlt als Datei.
        let archive = try store.indexGids(.init(allowedMailboxIds: [f.mailboxId(named: "archiv2024")], afterGid: 0, limit: 100))
        #expect(archive.gids == [.init(gid: f.gid(named: "dup3"), hasFile: true)])
    }

    @Test func gidsHasFileMatchesMessageRowFile() throws {
        let r = try store.indexGids(.init(allowedMailboxIds: all, afterGid: 0, limit: 20000))
        let rows = try store.search(.init(allowedMailboxIds: all, limit: 100)).messages
        let fileByGid = Dictionary(uniqueKeysWithValues: rows.map { ($0.gid, $0.file != .none) })
        for e in r.gids { #expect(fileByGid[e.gid] == e.hasFile, "gid \(e.gid)") }
    }

    @Test func gidsSkipDeletedAndDisallowed() throws {
        let noJunk = all.filter { $0 != f.mailboxId(named: "junk") }
        let r = try store.indexGids(.init(allowedMailboxIds: noJunk, afterGid: 0, limit: 20000))
        let gids = Set(r.gids.map(\.gid))
        #expect(!gids.contains(f.gid(named: "deleted")))
        #expect(!gids.contains(f.gid(named: "thread3")))
        #expect(gids.contains(f.gid(named: "dup3")))
    }

    @Test func gidsEncodeAsPairs() throws {
        let d = Dispatcher(store: store, signing: .trusted)
        let allowed = all.map(String.init).joined(separator: ",")
        let line = Data(#"{"id":1,"command":"index-gids","payload":{"allowedMailboxIds":[\#(allowed)],"afterGid":1001,"limit":1}}"#.utf8)
        let out = try #require(try JSONSerialization.jsonObject(with: d.handle(line: line)) as? [String: Any])
        let result = try #require(out["result"] as? [String: Any])
        #expect(NSDictionary(dictionary: result).isEqual(to: ["gids": [[1002, true]], "hasMore": true]))
    }

    @Test(arguments: [0, 20001])
    func gidsRejectLimitOutOfRange(_ limit: Int) {
        #expect(throws: HelperFailure.self) { try store.indexGids(.init(allowedMailboxIds: all, afterGid: 0, limit: limit)) }
    }

    @Test func gidsRejectEmptyAllowedAndNegativeAfter() {
        #expect(throws: HelperFailure.self) { try store.indexGids(.init(allowedMailboxIds: [], afterGid: 0, limit: 10)) }
        #expect(throws: HelperFailure.self) { try store.indexGids(.init(allowedMailboxIds: all, afterGid: -1, limit: 10)) }
    }

    // MARK: - search mit gids

    @Test func searchWithGidsKeepsOrderAndFilters() throws {
        let wanted = ["small", "dup3", "invoice", "thread3", "deleted"].map { f.gid(named: $0) }
        let noJunk = all.filter { $0 != f.mailboxId(named: "junk") }
        let r = try store.search(.init(allowedMailboxIds: noJunk, gids: wanted, limit: 10))
        // thread3 nur in Junk, deleted geloescht: beide fehlen. Reihenfolge wie ohne gids.
        #expect(r.messages.map(\.gid) == ["invoice", "dup3", "small"].map { f.gid(named: $0) })
        let plain = try store.search(.init(allowedMailboxIds: noJunk, limit: 100)).messages.map(\.gid)
        #expect(plain.filter { Set(r.messages.map(\.gid)).contains($0) } == r.messages.map(\.gid))
        // Weitere Filter wirken zusaetzlich.
        let unread = try store.search(.init(allowedMailboxIds: noJunk, flagged: true, gids: wanted, limit: 10))
        #expect(Set(unread.messages.map(\.gid)).isSubset(of: Set(r.messages.map(\.gid))))
        let subj = try store.search(.init(allowedMailboxIds: noJunk, subject: "nothing-matches-this", gids: wanted, limit: 10))
        #expect(subj.messages.isEmpty)
    }

    @Test func searchWithGidsPagesByKeyset() throws {
        let wanted = f.visibleGids.sorted()
        var seen: [Int64] = []
        var after: SearchRequest.After? = nil
        repeat {
            let r = try store.search(.init(allowedMailboxIds: all, gids: wanted, after: after, limit: 3))
            seen += r.messages.map(\.gid)
            after = r.hasMore ? .init(date: r.messages.last!.dateReceived, gid: r.messages.last!.gid) : nil
        } while after != nil
        #expect(seen == (try store.search(.init(allowedMailboxIds: all, limit: 100))).messages.map(\.gid))
    }

    @Test func searchWithEmptyGidsFindsNothingAndCounts() throws {
        let r = try store.search(.init(allowedMailboxIds: all, gids: [], limit: 10, countTotal: true))
        #expect(r.messages.isEmpty && !r.hasMore)
        #expect(r.totalMatched == 0)
    }

    @Test func searchWithGidsIgnoresDuplicatesAndUnknown() throws {
        let g = f.gid(named: "small")
        let r = try store.search(.init(allowedMailboxIds: all, gids: [g, g, 999_999], limit: 10, countTotal: true))
        #expect(r.messages.map(\.gid) == [g])
        #expect(r.totalMatched == 1)
    }

    @Test func searchGidsDoNotLeakIntoTheNextSearch() throws {
        _ = try store.search(.init(allowedMailboxIds: all, gids: [f.gid(named: "small")], limit: 10))
        let plain = try store.search(.init(allowedMailboxIds: all, limit: 100))
        #expect(Set(plain.messages.map(\.gid)) == f.visibleGids)
        let other = try store.search(.init(allowedMailboxIds: all, gids: [f.gid(named: "invoice")], limit: 10))
        #expect(other.messages.map(\.gid) == [f.gid(named: "invoice")])
    }

    @Test func searchAcceptsMaxGidsAndRejectsMore() throws {
        let many = (1...Int64(searchMaxGids)).map { $0 }
        let r = try store.search(.init(allowedMailboxIds: all, gids: many, limit: 100))
        #expect(Set(r.messages.map(\.gid)) == f.visibleGids)
        #expect(throws: HelperFailure.self) {
            try store.search(.init(allowedMailboxIds: all, gids: many + [Int64(searchMaxGids) + 1], limit: 10))
        }
    }

    // MARK: - Dispatcher

    @Test func dispatcherRejectsUnknownFieldsOfIndexCommands() {
        let d = Dispatcher(store: store, signing: .trusted)
        for command in ["index-feed", "index-gids"] {
            let line = Data(#"{"id":1,"command":"\#(command)","payload":{"allowedMailboxIds":[1],"afterRowid":0,"afterGid":0,"limit":1,"path":"/"}}"#.utf8)
            let out = String(decoding: d.handle(line: line), as: UTF8.self)
            #expect(out.contains(#""code":"INVALID_INPUT""#), "\(command)")
            #expect(out.contains("Unknown field"), "\(command)")
        }
    }

    @Test func dispatcherRefusesIndexCommandsWhenUntrusted() {
        let d = Dispatcher(store: store, signing: .untrusted("test"))
        let feed = Data(#"{"id":1,"command":"index-feed","payload":{"allowedMailboxIds":[1],"afterRowid":0,"limit":1}}"#.utf8)
        let gids = Data(#"{"id":2,"command":"index-gids","payload":{"allowedMailboxIds":[1],"afterGid":0,"limit":1}}"#.utf8)
        for line in [feed, gids] {
            #expect(String(decoding: d.handle(line: line), as: UTF8.self).contains("HELPER_UNTRUSTED_SIGNATURE"))
        }
    }
}
