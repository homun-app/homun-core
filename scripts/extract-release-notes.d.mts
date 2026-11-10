// Dichiarazioni per l'estrattore CI delle note di release (usato dai test:
// il file .mjs non ha tipi propri — la firma è quella dello script).
export declare function extractReleaseNotes(changelog: string, version: string): string | null
export declare const CHANGELOG_PATH: string
