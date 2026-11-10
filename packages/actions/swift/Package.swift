// swift-tools-version:6.0
import PackageDescription

// Eigenes Paket, getrennt von swift/: das Lesepaket liefert nichts davon aus.
let package = Package(
    name: "mail-actions",
    platforms: [.macOS(.v15)],
    targets: [
        .target(name: "MailActionsCore"),
        .executableTarget(
            name: "mail-actions",
            dependencies: ["MailActionsCore"]
        ),
        .testTarget(
            name: "MailActionsCoreTests",
            dependencies: ["MailActionsCore"]
        ),
    ]
)
