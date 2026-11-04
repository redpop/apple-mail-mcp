import AppKit
import CoreServices
import Foundation

/// Alles, was Mail beruehrt, liegt hinter diesem Protokoll: Tests benutzen eine Attrappe und senden
/// nie ein Apple Event.
public protocol AppleEvents {
    /// Fragt nur das System, sendet kein Event an Mail und startet Mail nicht.
    var isMailRunning: Bool { get }
    /// Rohwert von `AEDeterminePermissionToAutomateTarget`. Nur mit `ask` darf ein Dialog erscheinen.
    func determinePermission(ask: Bool) -> Int32
    /// Fuehrt das Skript aus. `errorNumber` ist 0 bei Erfolg. Bewusst nur die Nummer: Fehlertexte
    /// von Mail koennen Inhalte nennen.
    func execute(source: String) -> (descriptor: NSAppleEventDescriptor?, errorNumber: Int)
}

/// Die echte Anbindung. Laeuft auf dem Hauptthread, wie NSAppleScript es verlangt: die Serve-Schleife
/// arbeitet dort jede Anfrage nacheinander ab.
public struct SystemAppleEvents: AppleEvents {
    private static let mailBundleId = "com.apple.mail"

    public init() {}

    public var isMailRunning: Bool {
        // Die Serve-Schleife blockiert in read(): ohne einen Lauf der Runloop bekommt dieser
        // langlebige Prozess Aenderungen an der Prozessliste eventuell nicht mit. Eine veraltete
        // Antwort "laeuft" wuerde das Skript senden und damit Mail starten.
        RunLoop.main.run(mode: .default, before: Date())
        return NSRunningApplication.runningApplications(withBundleIdentifier: Self.mailBundleId)
            .contains { !$0.isTerminated }
    }

    public func determinePermission(ask: Bool) -> Int32 {
        let target = NSAppleEventDescriptor(bundleIdentifier: Self.mailBundleId)
        // typeWildCard ('****'): die Freigabe gilt fuer Mail als Ganzes.
        let wildcard = AEEventClass(0x2A2A_2A2A)
        return AEDeterminePermissionToAutomateTarget(target.aeDesc, wildcard, AEEventID(0x2A2A_2A2A), ask)
    }

    public func execute(source: String) -> (descriptor: NSAppleEventDescriptor?, errorNumber: Int) {
        guard let script = NSAppleScript(source: source) else { return (nil, -1) }
        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)
        if let error { return (nil, (error[NSAppleScript.errorNumber] as? Int) ?? -1) }
        return (result, 0)
    }
}
