import Foundation
import Testing

@Test func fixtureManifestHasEveryRequiredControl() throws {
    let ids = try fixtureElementIdentifiers()

    #expect(Set(ids) == [
        "fixture.button",
        "fixture.checkbox",
        "fixture.text",
        "fixture.secure",
        "fixture.popup",
        "fixture.scroll",
        "fixture.secondary",
        "fixture.drag-source",
        "fixture.drag-destination",
    ])
    #expect(ids.count == Set(ids).count)
}

private func fixtureElementIdentifiers() throws -> [String] {
    let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let data = try Data(
        contentsOf: packageRoot.appending(path: "Fixtures/fixture-elements-v1.json")
    )
    return try JSONDecoder().decode([String].self, from: data)
}
