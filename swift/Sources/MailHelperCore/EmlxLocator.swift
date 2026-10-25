import Foundation

/// Gefundene .emlx-Datei. `url` ist der zusammengesetzte Kandidatenpfad, `resolvedPath` der per
/// realpath aufgeloeste Pfad, aus dem gelesen wird.
public struct Located: Equatable, Sendable {
    public let url: URL
    public let state: FileState
    let resolvedPath: String
}

/// Inhalt einer gelesenen .emlx (hoechstens `maxBytes` Bytes) und die wahre Dateigroesse.
struct EmlxContent {
    let data: Data
    let size: Int64
    var read: Bool = true
}

/// Findet .emlx-Dateien aus ROWID und Mailbox-URL (Spec 6). Nicht thread-sicher: der Helper arbeitet seriell.
public final class EmlxLocator {
    private let versionDir: URL
    /// Store-UUID-Kandidaten je .mbox-Verzeichnis, fuer die Lebenszeit des Helpers.
    private var storeCache: [String: [String]] = [:]
    /// .mbox-Verzeichnisse, die in dieser Anfrage schon neu gelistet wurden.
    private var relisted: Set<String> = []
    /// realpath(versionDir), einmal je Anfrage berechnet.
    private var realRoot: String?
    /// Anzahl der Verzeichnislistings (Testhaken).
    private(set) var listingCount = 0

    public init(versionDir: URL) {
        self.versionDir = versionDir
    }

    /// Eine neue Anfrage beginnt: Cache-Fehlschlaege duerfen ihr .mbox-Verzeichnis wieder einmal neu listen.
    public func beginRequest() {
        relisted.removeAll()
        realRoot = nil
    }

    public func fileState(rowid: Int64, mailboxURL: String) -> FileState {
        locate(rowid: rowid, mailboxURL: mailboxURL)?.state ?? .none
    }

    public func locate(rowid: Int64, mailboxURL: String) -> Located? {
        guard rowid > 0, let mbox = Self.mboxPath(versionDir: versionDir.path, mailboxURL: mailboxURL) else { return nil }
        if realRoot == nil { realRoot = Self.realpathString(versionDir.path) }
        guard let root = realRoot else { return nil }
        let prefix = root.hasSuffix("/") ? root : root + "/"

        let digits = Self.digitDirs(rowid: rowid)
        func candidates(store: String, suffix: String) -> String {
            var p = mbox + "/" + store + "/Data"
            for d in digits { p += "/" + d }
            return p + "/Messages/" + String(rowid) + suffix
        }
        func search(_ stores: [String]) -> Located? {
            for (suffix, state) in [(".emlx", FileState.full), (".partial.emlx", FileState.partial)] {
                for store in stores {
                    let candidate = candidates(store: store, suffix: suffix)
                    guard let resolved = Self.realpathString(candidate), resolved.hasPrefix(prefix) else { continue }
                    var st = stat()
                    guard stat(resolved, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { continue }
                    return Located(url: URL(fileURLWithPath: candidate), state: state, resolvedPath: resolved)
                }
            }
            return nil
        }

        // Kaltstart: das erste Listing zaehlt als das eine Listing dieser Anfrage.
        let cached: [String]
        if let c = storeCache[mbox] {
            cached = c
        } else {
            relisted.insert(mbox)
            cached = listStores(mbox)
        }
        if let hit = search(cached) { return hit }
        // Fehlschlag: ein spaeter angelegter Store wird gefunden, wenn das Verzeichnis neu gelistet wird.
        guard relisted.insert(mbox).inserted else { return nil }
        let fresh = listStores(mbox)
        guard fresh != cached else { return nil }
        return search(fresh)
    }

    /// Oeffnet, ermittelt die Groesse und liest hoechstens `maxBytes` Bytes, aber nur wenn `admit` die
    /// Menge `min(Groesse, maxBytes)` zulaesst. `nil`, wenn die Datei nicht zu oeffnen oder zu lesen ist.
    /// `data` ist leer und `read` false, wenn `admit` ablehnt; `size` ist immer die wahre Dateigroesse.
    func read(_ located: Located, maxBytes: Int, admit: (Int) -> Bool = { _ in true }) -> EmlxContent? {
        // O_NOFOLLOW_ANY: auch ein zwischen realpath und open ausgetauschtes Verzeichnis wird nicht verfolgt.
        let fd = open(located.resolvedPath, O_RDONLY | O_NOFOLLOW_ANY)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return nil }
        let size = Int64(st.st_size)
        let want = Int(min(size, Int64(max(maxBytes, 0))))
        guard admit(want) else { return EmlxContent(data: Data(), size: size, read: false) }
        var data = Data(count: want)
        var got = 0
        let ok: Bool = data.withUnsafeMutableBytes { buf in
            while got < want {
                let n = Darwin.read(fd, buf.baseAddress! + got, want - got)
                if n < 0 { if errno == EINTR { continue }; return false }
                if n == 0 { break }
                got += n
            }
            return true
        }
        guard ok else { return nil }
        if got < want { data.removeSubrange(got...) }
        return EmlxContent(data: data, size: size, read: true)
    }

    // MARK: - Pfadbau

    /// Ziffernverzeichnisse (Spec 6): q = rowid / 1000, ziffernweise in umgekehrter Reihenfolge; q == 0 ohne Ebene.
    static func digitDirs(rowid: Int64) -> [String] {
        let q = rowid / 1000
        return q == 0 ? [] : String(q).reversed().map { String($0) }
    }

    /// `<versionDir>/<konto>/<seg>.mbox[/<seg>.mbox...]` oder nil (Schema, Segmente, Spec 6 Schritt 1).
    static func mboxPath(versionDir: String, mailboxURL: String) -> String? {
        guard let sep = mailboxURL.range(of: "://") else { return nil }
        let scheme = mailboxURL[..<sep.lowerBound].lowercased()
        guard scheme == "imap" || scheme == "local" else { return nil }
        let parts = mailboxURL[sep.upperBound...].split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count >= 2 else { return nil }
        var segments: [String] = []
        for part in parts {
            guard let s = String(part).removingPercentEncoding,
                  !s.isEmpty, s != ".", s != "..",
                  !s.contains("/"), !s.unicodeScalars.contains("\u{0}") else { return nil }
            segments.append(s)
        }
        var path = versionDir + "/" + segments[0]
        for s in segments.dropFirst() { path += "/" + s + ".mbox" }
        return path
    }

    /// Unterverzeichnisse mit UUID-Namen, die ein Data-Verzeichnis enthalten, in fester Reihenfolge; Ergebnis wird gecacht.
    private func listStores(_ mbox: String) -> [String] {
        listingCount += 1
        let names = (try? FileManager.default.contentsOfDirectory(atPath: mbox)) ?? []
        var out: [String] = []
        for name in names.sorted() {
            guard name.utf8.count == 36, UUID(uuidString: name) != nil else { continue }
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: mbox + "/" + name + "/Data", isDirectory: &isDir), isDir.boolValue {
                out.append(name)
            }
        }
        storeCache[mbox] = out
        return out
    }

    private static func realpathString(_ path: String) -> String? {
        guard let p = realpath(path, nil) else { return nil }
        defer { free(p) }
        return String(cString: p)
    }
}
