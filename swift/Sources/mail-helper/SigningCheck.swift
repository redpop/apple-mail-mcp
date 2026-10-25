import Foundation
import MailHelperCore
import Security

// Muessen mit src/signing.ts und swift/build.sh uebereinstimmen (Spec 13.1).
private let teamID = "4KTGF63CD2"
private let releaseBundleID = "io.github.redpop.apple-mail-mcp.mail-helper"
private let devBundleID = releaseBundleID + ".dev"
private let adhocBundleID = releaseBundleID + ".adhoc"

private let releaseRequirement =
    "identifier \"\(releaseBundleID)\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[subject.OU] = \"\(teamID)\""
private let devRequirement = "anchor apple generic and certificate leaf[subject.OU] = \"\(teamID)\""

/// Selbstpruefung der Signatur (Spec 13.2). Der Grund geht nur auf stderr, nie in eine Antwort.
enum SigningCheck {
    static func evaluate(bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> SigningState {
        switch bundleIdentifier {
        case releaseBundleID:
            return check(requirement: releaseRequirement, label: "release")
        case devBundleID:
            return check(requirement: devRequirement, label: "development")
        case adhocBundleID:
            return .trusted
        default:
            return .untrusted("unexpected bundle identifier")
        }
    }

    private static func check(requirement text: String, label: String) -> SigningState {
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
