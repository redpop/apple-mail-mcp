import Testing
@testable import MailHelperCore

@Test func foldMatchesUmlautsAndSharpS() {
    #expect(fold("Ärger") == fold("ärger"))
    #expect(fold("STRASSE") == fold("straße"))
    #expect(fold("Ärger") != fold("arger"))
}

@Test func foldNormalizesToNFC() {
    #expect(fold("A\u{0308}rger") == fold("\u{00C4}rger"))
}
