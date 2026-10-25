import Foundation
import Testing
@testable import MailHelperCore

@Suite struct EmlxLocatorTests {
    let f: Fixture
    let locator: EmlxLocator

    init() throws {
        f = try FixtureBuilder.build()
        locator = EmlxLocator(versionDir: f.mailRoot.appending(path: "V10"))
    }

    private func expectedState(_ rowid: Int64) -> FileState {
        FileState(rawValue: f.seed.messages.first { $0.rowid == rowid }!.file)!
    }

    // 7: q == 0, 4711: eine Ziffer, 123456: drei Ziffern (partial)
    @Test(arguments: [Int64(7), 4711, 123456]) func locatesByDigitRule(rowid: Int64) throws {
        let hit = try #require(locator.locate(rowid: rowid, mailboxURL: f.urlOfMessage(rowid: rowid)))
        #expect(hit.url.path == f.expectedEmlxPath(rowid: rowid).path)
        #expect(hit.state == expectedState(rowid))
    }

    @Test func literalPathsForDigitRule() throws {
        let v = f.mailRoot.path + "/V10/A0000000-0000-4000-8000-00000000000A"
        let inbox = "imap://A0000000-0000-4000-8000-00000000000A/INBOX"
        #expect(locator.locate(rowid: 4711, mailboxURL: inbox)?.url.path
                == v + "/INBOX.mbox/5D0E0001-0000-4000-8000-000000000001/Data/4/Messages/4711.emlx")
        #expect(locator.locate(rowid: 7, mailboxURL: inbox)?.url.path
                == v + "/INBOX.mbox/5D0E0001-0000-4000-8000-000000000001/Data/Messages/7.emlx")
        #expect(locator.locate(rowid: 123456, mailboxURL: "imap://A0000000-0000-4000-8000-00000000000A/Archiv/2024")?.url.path
                == v + "/Archiv.mbox/2024.mbox/5D0E0002-0000-4000-8000-000000000001/Data/3/2/1/Messages/123456.partial.emlx")
    }

    @Test func prefersFullOverPartial() throws {
        let inbox = f.urlOfMessage(rowid: 4711)
        let full = f.expectedEmlxPath(rowid: 4711)
        let partial = full.deletingLastPathComponent().appending(path: "4711.partial.emlx")
        try Data("x".utf8).write(to: partial)
        #expect(locator.locate(rowid: 4711, mailboxURL: inbox)?.state == .full)
        try FileManager.default.removeItem(at: full)
        let hit = try #require(locator.locate(rowid: 4711, mailboxURL: inbox))
        #expect(hit.state == .partial)
        #expect(hit.url.path == partial.path)
    }

    @Test func missingFileGivesNilAndNone() throws {
        // 21: file none im Seed
        #expect(locator.locate(rowid: 21, mailboxURL: f.urlOfMessage(rowid: 21)) == nil)
        #expect(locator.fileState(rowid: 21, mailboxURL: f.urlOfMessage(rowid: 21)) == .none)
        #expect(locator.fileState(rowid: 0, mailboxURL: f.urlOfMessage(rowid: 7)) == .none)
        #expect(locator.fileState(rowid: -5, mailboxURL: f.urlOfMessage(rowid: 7)) == .none)
    }

    @Test func findsFileInSecondStoreUUID() throws {
        // 29 liegt im zweiten, 32 im ersten Store derselben Mailbox
        for rowid: Int64 in [29, 32, 37] {
            let hit = try #require(locator.locate(rowid: rowid, mailboxURL: f.urlOfMessage(rowid: rowid)))
            #expect(hit.url.path == f.expectedEmlxPath(rowid: rowid).path)
        }
        #expect(f.expectedEmlxPath(rowid: 29).path.contains("5D0E0007-0000-4000-8000-000000000002"))
    }

    @Test func storeCreatedLaterIsFoundOnNextRequest() throws {
        let url = f.urlOfMessage(rowid: 29)
        locator.beginRequest()
        #expect(locator.locate(rowid: 29, mailboxURL: url) != nil)   // Cache gefuellt
        let box = FixtureBuilder.mboxDirectory(root: f.mailRoot, url: url)
        let newMessages = box.appending(path: "5D0E0007-0000-4000-8000-000000000003/Data/Messages")
        try FileManager.default.createDirectory(at: newMessages, withIntermediateDirectories: true)
        try Data("neu".utf8).write(to: newMessages.appending(path: "99.emlx"))
        locator.beginRequest()
        let hit = try #require(locator.locate(rowid: 99, mailboxURL: url))
        #expect(hit.url.path == newMessages.appending(path: "99.emlx").path)
        // Verzeichnisse ohne Data oder ohne UUID-Namen sind keine Stores.
        try FileManager.default.createDirectory(at: box.appending(path: "5D0E0007-0000-4000-8000-000000000004"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: box.appending(path: "Attachments/Data/Messages"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: box.appending(path: "Attachments/Data/Messages/98.emlx"))
        locator.beginRequest()
        #expect(locator.locate(rowid: 98, mailboxURL: url) == nil)
    }

    @Test func listsAMailboxOncePerRequest() throws {
        let url = f.urlOfMessage(rowid: 29)
        locator.beginRequest()
        // Kaltstart mit Treffern und Fehlschlaegen in einer Mailbox: genau ein Listing.
        #expect(locator.locate(rowid: 29, mailboxURL: url) != nil)
        #expect(locator.locate(rowid: 77, mailboxURL: url) == nil)
        #expect(locator.locate(rowid: 78, mailboxURL: url) == nil)
        #expect(locator.locate(rowid: 37, mailboxURL: url) != nil)
        #expect(locator.listingCount == 1)
        // Warmer Cache, naechste Anfrage: Fehlschlaege listen hoechstens einmal neu.
        locator.beginRequest()
        #expect(locator.locate(rowid: 77, mailboxURL: url) == nil)
        #expect(locator.locate(rowid: 78, mailboxURL: url) == nil)
        #expect(locator.listingCount == 2)
    }

    @Test func percentEncodedAndUmlautSegments() throws {
        // Spezial%C3%84rger, %5BGmail%5D/All%20Mail, Gesendete%20Objekte, local://
        for rowid: Int64 in [29, 34, 25, 33] {
            let hit = try #require(locator.locate(rowid: rowid, mailboxURL: f.urlOfMessage(rowid: rowid)), "rowid \(rowid)")
            #expect(hit.url.path == f.expectedEmlxPath(rowid: rowid).path)
        }
        #expect(f.urlOfMessage(rowid: 29).contains("%C3%84"))
        #expect(locator.locate(rowid: 33, mailboxURL: "local://10CA1000-0000-4000-8000-00000000000C/Lokal")?.url.path
                == f.mailRoot.path + "/V10/10CA1000-0000-4000-8000-00000000000C/Lokal.mbox/5D0E0008-0000-4000-8000-000000000001/Data/Messages/33.emlx")
        // Zerlegte Schreibweise (A + U+0308) trifft dasselbe Verzeichnis, das Dateisystem loest auf.
        let nfd = "imap://A0000000-0000-4000-8000-00000000000A/Spezial%41%CC%88rger"
        #expect(locator.locate(rowid: 32, mailboxURL: nfd)?.state == .full)
    }

    @Test func schemeRules() throws {
        let a = "A0000000-0000-4000-8000-00000000000A"
        #expect(locator.locate(rowid: 7, mailboxURL: "IMAP://\(a)/INBOX")?.state == .full)
        #expect(locator.locate(rowid: 7, mailboxURL: "ews://\(a)/INBOX") == nil)
        #expect(locator.locate(rowid: 7, mailboxURL: "pop://\(a)/INBOX") == nil)
        #expect(locator.locate(rowid: 7, mailboxURL: "INBOX") == nil)
        #expect(locator.locate(rowid: 7, mailboxURL: "imap://\(a)") == nil)
    }

    @Test func dotDotSegmentGivesNil() throws {
        let a = "A0000000-0000-4000-8000-00000000000A"
        for bad in ["imap://\(a)/../x", "imap://\(a)/%2E%2E/INBOX", "imap://\(a)/./INBOX", "imap://\(a)/INBOX/",
                    "imap://\(a)//INBOX", "imap://\(a)/IN%2FBOX", "imap://\(a)/IN%00BOX", "imap://../INBOX",
                    "imap://\(a)/INBOX%", "imap://\(a)/%2e%2e"] {
            #expect(locator.locate(rowid: 7, mailboxURL: bad) == nil, "\(bad)")
        }
    }

    @Test func symlinkOutsideRootGivesNil() throws {
        let outside = f.mailRoot.deletingLastPathComponent().appending(path: "outside.emlx")
        try Data("5\nhallo".utf8).write(to: outside)
        let inbox = f.urlOfMessage(rowid: 7)
        let file = f.expectedEmlxPath(rowid: 7)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: outside)
        #expect(locator.locate(rowid: 7, mailboxURL: inbox) == nil)
        #expect(locator.fileState(rowid: 7, mailboxURL: inbox) == .none)

        // Auch ein Verzeichnis-Symlink im Data-Baum fuehrt hinaus.
        let outDir = f.mailRoot.deletingLastPathComponent().appending(path: "outdir")
        try FileManager.default.createDirectory(at: outDir.appending(path: "Messages"), withIntermediateDirectories: true)
        try Data("5\nhallo".utf8).write(to: outDir.appending(path: "Messages/20.emlx"))
        let box = FixtureBuilder.mboxDirectory(root: f.mailRoot, url: inbox)
        let data = box.appending(path: "5D0E0001-0000-4000-8000-000000000001/Data")
        try FileManager.default.removeItem(at: data.appending(path: "Messages"))
        try FileManager.default.createSymbolicLink(at: data.appending(path: "Messages"), withDestinationURL: outDir.appending(path: "Messages"))
        #expect(locator.locate(rowid: 20, mailboxURL: inbox) == nil)
    }

    @Test func symlinkInsideRootIsAcceptedButResolved() throws {
        // Ziel innerhalb des Baums ist erlaubt (realpath liegt unter der Wurzel).
        let inbox = f.urlOfMessage(rowid: 7)
        let file = f.expectedEmlxPath(rowid: 7)
        let target = file.deletingLastPathComponent().appending(path: "target.bin")
        try FileManager.default.moveItem(at: file, to: target)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
        let hit = try #require(locator.locate(rowid: 7, mailboxURL: inbox))
        #expect(hit.resolvedPath.hasSuffix("/Messages/target.bin"))
        #expect(locator.read(hit, maxBytes: 10) != nil)
    }
}
