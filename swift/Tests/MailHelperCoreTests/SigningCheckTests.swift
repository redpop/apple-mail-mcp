import Foundation
import Testing
@testable import MailHelperCore

@Suite struct SigningCheckTests {
    /// Zeichnet auf, welches Requirement geprueft wurde, und liefert ein festes Ergebnis.
    final class Recorder: @unchecked Sendable {
        var calls: [(String, String)] = []
        var answer: SigningState = .trusted
        func verify(_ requirement: String, _ label: String) -> SigningState {
            calls.append((requirement, label))
            return answer
        }
    }

    private func isTrusted(_ s: SigningState) -> Bool {
        if case .trusted = s { return true }
        return false
    }

    private func reason(_ s: SigningState) -> String? {
        if case .untrusted(let r) = s { return r }
        return nil
    }

    @Test func releaseIdChecksTheReleaseRequirement() {
        let r = Recorder()
        #expect(isTrusted(SigningCheck.evaluate(bundleIdentifier: SigningCheck.releaseBundleID, verify: r.verify)))
        #expect(r.calls.count == 1)
        #expect(r.calls.first?.0 == SigningCheck.releaseRequirement)
        #expect(r.calls.first?.1 == "release")
        r.answer = .untrusted("nope")
        #expect(reason(SigningCheck.evaluate(bundleIdentifier: SigningCheck.releaseBundleID, verify: r.verify)) == "nope")
    }

    @Test func devIdChecksTheDevelopmentRequirement() {
        let r = Recorder()
        #expect(isTrusted(SigningCheck.evaluate(bundleIdentifier: SigningCheck.devBundleID, verify: r.verify)))
        #expect(r.calls.count == 1)
        #expect(r.calls.first?.0 == SigningCheck.devRequirement)
        #expect(r.calls.first?.1 == "development")
    }

    @Test func adhocIdIsTrustedWithoutCheck() {
        let r = Recorder()
        #expect(isTrusted(SigningCheck.evaluate(bundleIdentifier: SigningCheck.adhocBundleID, verify: r.verify)))
        #expect(r.calls.isEmpty)
    }

    @Test func otherIdsAreUntrustedWithoutCheck() {
        let r = Recorder()
        for id in [nil, "", "com.example.other", SigningCheck.releaseBundleID + ".evil", SigningCheck.releaseBundleID.uppercased()] {
            #expect(reason(SigningCheck.evaluate(bundleIdentifier: id, verify: r.verify)) == "unexpected bundle identifier")
        }
        #expect(r.calls.isEmpty)
    }

    @Test func requirementsPinTeamIdentifierAndCertificateKind() {
        let team = #"certificate leaf[subject.OU] = "4KTGF63CD2""#
        #expect(SigningCheck.releaseRequirement.contains(team))
        #expect(SigningCheck.releaseRequirement.contains(#"identifier "io.github.redpop.apple-mail-mcp.mail-helper" "#))
        #expect(SigningCheck.releaseRequirement.contains("certificate 1[field.1.2.840.113635.100.6.2.6] exists"))
        #expect(SigningCheck.devRequirement.contains(team))
        #expect(SigningCheck.devRequirement.contains(#"identifier "io.github.redpop.apple-mail-mcp.mail-helper.dev" "#))
        // Apple Development, nicht jedes Apple-Zertifikat des Teams.
        #expect(SigningCheck.devRequirement.contains("certificate 1[field.1.2.840.113635.100.6.2.1] exists"))
        #expect(!SigningCheck.devRequirement.contains("100.6.2.6"))
    }

    @Test func requirementsAreValidSyntax() {
        for text in [SigningCheck.releaseRequirement, SigningCheck.devRequirement] {
            var requirement: SecRequirement?
            #expect(SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement) == errSecSuccess)
        }
    }

    @Test func verifySelfRejectsTheTestProcess() {
        // Der Testprozess traegt weder Release- noch Dev-Signatur des Bundles.
        for (text, label) in [(SigningCheck.releaseRequirement, "release"), (SigningCheck.devRequirement, "development")] {
            let r = reason(SigningCheck.verifySelf(requirement: text, label: label))
            #expect(r != nil)
        }
        #expect(reason(SigningCheck.verifySelf(requirement: "this is not a requirement", label: "x")) == "cannot build x requirement")
    }
}
