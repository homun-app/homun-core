// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "HomunHostComputer",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HomunComputerProtocol", targets: ["HomunComputerProtocol"]),
        .library(name: "HomunComputerServiceCore", targets: ["HomunComputerServiceCore"]),
        .executable(name: "HomunComputerService", targets: ["HomunComputerService"]),
        .executable(name: "HomunComputerFixture", targets: ["HomunComputerFixture"]),
    ],
    targets: [
        .target(name: "HomunComputerProtocol"),
        .target(
            name: "HomunComputerServiceCore",
            dependencies: ["HomunComputerProtocol"]
        ),
        .executableTarget(
            name: "HomunComputerService",
            dependencies: ["HomunComputerProtocol", "HomunComputerServiceCore"]
        ),
        .target(
            name: "HomunComputerFixtureCore",
            path: "Sources/HomunComputerFixture"
        ),
        .executableTarget(
            name: "HomunComputerFixture",
            dependencies: ["HomunComputerFixtureCore"],
            path: "Sources/HomunComputerFixtureExecutable"
        ),
        .testTarget(
            name: "HomunComputerProtocolTests",
            dependencies: [
                "HomunComputerProtocol",
                "HomunComputerServiceCore",
                "HomunComputerFixtureCore",
            ]
        ),
    ]
)
