import Darwin
import Foundation
import MailActionsCore

/// Diagnose gehoert auf stderr: stdout traegt ausschliesslich das Zeilenprotokoll.
func serveLog(_ message: String) {
    FileHandle.standardError.write(Data(("mail-actions: " + message + "\n").utf8))
}

// MARK: - Disclaim

/// macOS ordnet die Automation-Freigabe (TCC) dem verantwortlichen ELTERNPROZESS zu.
/// `responsibility_spawnattrs_setdisclaim` gibt diese Verantwortung ab: der ersetzte Prozess wird
/// sein eigener Verantwortlicher, die Freigabe haengt am Bundle. Das Symbol wird per dlsym
/// aufgeloest; fehlt es, laeuft das Bundle ohne Disclaim weiter (mit stderr-Hinweis).
func reexecDisclaimed() {
    let marker = "MAIL_ACTIONS_DISCLAIMED"
    // Marker gesetzt: dies ist schon der ersetzte Prozess (sonst Endlosschleife).
    guard ProcessInfo.processInfo.environment[marker] == nil else { return }

    // RTLD_DEFAULT ist auf Darwin ((void *) -2).
    let rtldDefault = UnsafeMutableRawPointer(bitPattern: -2)
    guard let symbol = dlsym(rtldDefault, "responsibility_spawnattrs_setdisclaim") else {
        serveLog("disclaim symbol missing, continuing without")
        return
    }
    typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    let setDisclaim = unsafeBitCast(symbol, to: SetDisclaim.self)

    guard let executable = Bundle.main.executablePath else {
        serveLog("own path unknown, continuing without disclaim")
        return
    }

    var attributes: posix_spawnattr_t?
    let initResult = posix_spawnattr_init(&attributes)
    guard initResult == 0 else {
        serveLog("posix_spawnattr_init failed (\(String(cString: strerror(initResult)))), continuing without disclaim")
        return
    }
    defer { posix_spawnattr_destroy(&attributes) }
    // SETEXEC ersetzt das Prozessabbild an Ort und Stelle (kein Kindprozess).
    let flagsResult = posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETEXEC))
    guard flagsResult == 0 else {
        serveLog("posix_spawnattr_setflags failed (\(String(cString: strerror(flagsResult)))), continuing without disclaim")
        return
    }
    let disclaimResult = setDisclaim(&attributes, 1)
    if disclaimResult != 0 {
        serveLog("setdisclaim failed (\(disclaimResult)), automation may be denied")
    }

    var environment = ProcessInfo.processInfo.environment
    environment[marker] = "1"

    var cArguments: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
    cArguments.append(nil)
    var cEnvironment: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") }
    cEnvironment.append(nil)
    defer {
        for pointer in cArguments where pointer != nil { free(pointer) }
        for pointer in cEnvironment where pointer != nil { free(pointer) }
    }

    var pid: pid_t = 0
    let result = posix_spawn(&pid, executable, nil, &attributes, &cArguments, &cEnvironment)
    // Mit SETEXEC kehrt ein erfolgreicher Aufruf nie zurueck; alles ab hier ist ein Fehlschlag.
    serveLog("disclaim re-exec failed (\(String(cString: strerror(result)))), continuing without")
}

// MARK: - Serve

/// Hoechstlaenge einer Anfragezeile. Eine Anfrage traegt nur vier kurze Strings und eine Zahl.
let maxLineBytes = 1_048_576

let oversizedResponse = Data(
    #"{"id":null,"ok":false,"error":{"code":"INVALID_INPUT","message":"Request line exceeds 1 MiB."}}"#.utf8)

/// Exit-Code, wenn stdout nicht mehr schreibbar ist (Leser weg, EPIPE): die Antwort ging verloren,
/// das ist kein normales Ende.
let stdoutClosedExitCode: Int32 = 3

/// Schreibt Antwort plus Zeilenumbruch mit einem einzigen write-Aufruf (bei Teilschreibung Rest nachziehen).
/// false, wenn stdout nicht mehr schreibbar ist; der Grund steht dann schon auf stderr.
func writeLine(_ response: Data) -> Bool {
    var out = response
    out.append(0x0A)
    return out.withUnsafeBytes { raw -> Bool in
        var offset = 0
        while offset < raw.count {
            let n = write(STDOUT_FILENO, raw.baseAddress! + offset, raw.count - offset)
            if n < 0 {
                if errno == EINTR { continue }
                serveLog("stdout write failed (\(String(cString: strerror(errno)))), exiting")
                return false
            }
            offset += n
        }
        return true
    }
}

func serve(dispatcher: Dispatcher) -> Int32 {
    signal(SIGPIPE, SIG_IGN)
    var line = Data()
    var skipping = false  // laufende Zeile ist zu lang: bis zum naechsten Zeilenumbruch verwerfen
    var chunk = [UInt8](repeating: 0, count: 65536)

    func emit(_ request: Data) -> Bool {
        if request.isEmpty { return true }
        return writeLine(dispatcher.handle(line: request))
    }

    while true {
        let count = chunk.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
        if count < 0 {
            if errno == EINTR { continue }
            serveLog("stdin read error (\(errno))")
            return 1
        }
        if count == 0 {
            // EOF: eine unvollstaendige letzte Zeile ohne Zeilenumbruch noch beantworten.
            if !skipping, !line.isEmpty, !emit(line) { return stdoutClosedExitCode }
            return 0
        }
        var start = 0
        while start < count {
            if let newline = chunk[start..<count].firstIndex(of: 0x0A) {
                if skipping {
                    skipping = false
                } else if line.count + (newline - start) > maxLineBytes {
                    if !writeLine(oversizedResponse) { return stdoutClosedExitCode }
                } else {
                    line.append(contentsOf: chunk[start..<newline])
                    if !emit(line) { return stdoutClosedExitCode }
                }
                line.removeAll(keepingCapacity: true)
                start = newline + 1
            } else {
                if !skipping {
                    if line.count + (count - start) > maxLineBytes {
                        // Zu lang, Zeilenende noch nicht gesehen: sofort antworten, Rest verwerfen.
                        if !writeLine(oversizedResponse) { return stdoutClosedExitCode }
                        line.removeAll(keepingCapacity: true)
                        skipping = true
                    } else {
                        line.append(contentsOf: chunk[start..<count])
                    }
                }
                start = count
            }
        }
    }
}

// MARK: - Einstieg

// Vor allem anderen: nach dem Austausch beginnt der Prozess von vorn.
reexecDisclaimed()

let arguments = CommandLine.arguments
guard arguments.count == 2, arguments[1] == "serve" else {
    FileHandle.standardError.write(Data("usage: mail-actions serve\n".utf8))
    exit(2)
}

exit(serve(dispatcher: Dispatcher(events: SystemAppleEvents())))
