// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "mail-helper",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "MailHelperCore",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .executableTarget(
            name: "mail-helper",
            dependencies: ["MailHelperCore"]
        ),
        .testTarget(
            name: "MailHelperCoreTests",
            dependencies: ["MailHelperCore"]
        ),
    ]
)
