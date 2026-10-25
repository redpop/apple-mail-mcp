import Foundation

/// Ergebnis der Suche nach dem Mail-Verzeichnis.
enum MailRoot {
    struct Located {
        let name: String        // "V10"
        let envelopeIndex: URL
    }

    /// Sucht das hoechste `V<n>` mit `MailData/Envelope Index`. Reihenfolge der Pruefung
    /// per errno (vor SQLite): EPERM/EACCES -> FDA, ENOENT -> nicht gefunden.
    static func locate(root: URL) throws(HelperFailure) -> Located {
        let fda = HelperFailure(code: .fullDiskAccessRequired, message: "Full Disk Access is required to read the Mail directory.")
        let notFound = HelperFailure(code: .mailDataNotFound, message: "No Mail data directory with an Envelope Index was found.")

        guard let dir = opendir(root.path) else {
            switch errno {
            case EPERM, EACCES: throw fda
            case ENOENT, ENOTDIR: throw notFound
            default: throw HelperFailure(code: .databaseError, message: "The Mail directory cannot be listed.")
            }
        }
        var versions: [(n: Int, name: String)] = []
        while let entry = readdir(dir) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(NAME_MAX) + 1) { String(cString: $0) }
            }
            guard name.hasPrefix("V"), name.count > 1,
                  name.dropFirst().allSatisfy({ $0.isASCII && $0.isNumber }),
                  let n = Int(name.dropFirst()) else { continue }
            versions.append((n, name))
        }
        closedir(dir)

        for v in versions.sorted(by: { $0.n > $1.n }) {
            let idx = root.appending(path: v.name).appending(path: "MailData/Envelope Index")
            if let e = FileProbe.openErrno(idx.path) {
                if e == EPERM || e == EACCES { throw fda }
                continue
            }
            return Located(name: v.name, envelopeIndex: idx)
        }
        throw notFound
    }
}
