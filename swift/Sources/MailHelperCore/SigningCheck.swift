import Foundation
import Security

/// Selbstpruefung der Signatur (Spec 13.2). Der Grund geht nur auf stderr, nie in eine Antwort.
/// Liegt im Core, damit die Zuordnung Bundle-ID zu Requirement ohne echte Signatur testbar ist.
public enum SigningCheck {
    // Muessen mit src/signing.ts und swift/build.sh uebereinstimmen (Spec 13.1);
    // tests/signing.test.ts prueft die Uebereinstimmung.
    static let teamID = "4KTGF63CD2"
    static let releaseBundleID = "io.github.redpop.apple-mail-mcp.mail-helper"
    static let devBundleID = releaseBundleID + ".dev"
    static let adhocBundleID = releaseBundleID + ".adhoc"

    static let releaseRequirement =
        "identifier \"\(releaseBundleID)\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[subject.OU] = \"\(teamID)\""
    /// 1.2.840.113635.100.6.2.1 ist die WWDR-Zwischenstelle fuer Apple Development: andere Zertifikate
    /// des Teams (z. B. Developer ID) erfuellen dieses Requirement nicht.
    static let devRequirement =
        "identifier \"\(devBundleID)\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.1] exists and certificate leaf[subject.OU] = \"\(teamID)\""

    /// Prueft die eigene Signatur gegen ein Requirement (Text, Bezeichnung fuer die Meldung).
    public typealias Verify = (_ requirement: String, _ label: String) -> SigningState

    public static func evaluate(bundleIdentifier: String? = Bundle.main.bundleIdentifier,
                                verify: Verify = verifySelf) -> SigningState {
        switch bundleIdentifier {
        case releaseBundleID:
            return verify(releaseRequirement, "release")
        case devBundleID:
            return verify(devRequirement, "development")
        case adhocBundleID:
            return .trusted
        default:
            return .untrusted("unexpected bundle identifier")
        }
    }

    /// Prueft den laufenden Prozess gegen das Requirement.
    public static func verifySelf(requirement text: String, label: String) -> SigningState {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else {
            return .untrusted("cannot read own code signature")
        }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement
        else {
            return .untrusted("cannot build \(label) requirement")
        }
        let status = SecCodeCheckValidity(code, SecCSFlags(), requirement)
        return status == errSecSuccess ? .trusted : .untrusted("signature does not satisfy the \(label) requirement (\(status))")
    }
}
