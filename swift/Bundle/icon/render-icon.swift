// Zeichnet das App-Symbol (Umschlag mit Lupe) als PNG-Groessen fuer ein .iconset.
// Aufruf: render-icon.swift <ausgabeverzeichnis>   (make-icon.sh ruft es und danach iconutil auf)
import AppKit

func draw(size: Int) -> Data {
    let s = CGFloat(size)
    let image = NSImage(size: NSSize(width: s, height: s))
    image.lockFocus()
    let u = s / 1024
    func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x * u, y: y * u) }

    // Hintergrund: abgerundetes Quadrat, blauer Verlauf.
    let bg = NSBezierPath(roundedRect: NSRect(x: 100 * u, y: 100 * u, width: 824 * u, height: 824 * u), xRadius: 185 * u, yRadius: 185 * u)
    NSGradient(starting: NSColor(calibratedRed: 0.20, green: 0.52, blue: 0.98, alpha: 1),
               ending: NSColor(calibratedRed: 0.05, green: 0.27, blue: 0.75, alpha: 1))!.draw(in: bg, angle: -90)

    // Umschlag.
    let env = NSRect(x: 220 * u, y: 330 * u, width: 584 * u, height: 400 * u)
    let body = NSBezierPath(roundedRect: env, xRadius: 40 * u, yRadius: 40 * u)
    NSColor.white.setFill()
    body.fill()
    let flap = NSBezierPath()
    flap.move(to: p(250, 700))
    flap.line(to: p(512, 500))
    flap.line(to: p(774, 700))
    flap.lineWidth = 36 * u
    flap.lineCapStyle = .round
    flap.lineJoinStyle = .round
    NSColor(calibratedRed: 0.05, green: 0.27, blue: 0.75, alpha: 0.85).setStroke()
    flap.stroke()

    // Lupe unten rechts: weisser Ring mit Griff, blauer Rand fuer Kontrast.
    let lens = NSRect(x: 560 * u, y: 170 * u, width: 230 * u, height: 230 * u)
    let handle = NSBezierPath()
    handle.move(to: p(745, 215))
    handle.line(to: p(850, 110))
    handle.lineWidth = 70 * u
    handle.lineCapStyle = .round
    NSColor(calibratedRed: 0.03, green: 0.18, blue: 0.55, alpha: 1).setStroke()
    handle.stroke()
    let ring = NSBezierPath(ovalIn: lens)
    NSColor(calibratedRed: 0.8, green: 0.9, blue: 1, alpha: 0.95).setFill()
    ring.fill()
    ring.lineWidth = 46 * u
    NSColor(calibratedRed: 0.03, green: 0.18, blue: 0.55, alpha: 1).setStroke()
    ring.stroke()

    image.unlockFocus()
    let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try draw(size: base).write(to: URL(fileURLWithPath: "\(out)/icon_\(base)x\(base).png"))
    try draw(size: base * 2).write(to: URL(fileURLWithPath: "\(out)/icon_\(base)x\(base)@2x.png"))
}
