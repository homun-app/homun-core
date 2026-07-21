// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "HomunHostComputer",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HomunComputerProtocol", targets: ["HomunComputerProtocol"]),
        .library(name: "HomunComputerServiceCore", targets: ["HomunComputerServiceCore"]),
        .executable(name: "HomunComputerService", targets: ["HomunComputerService"]),
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
        .testTarget(
            name: "HomunComputerProtocolTests",
            dependencies: ["HomunComputerProtocol", "HomunComputerServiceCore"]
        ),
    ]
)
