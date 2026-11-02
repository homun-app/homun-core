#!/usr/bin/env node
// Estrae UNA versione da CHANGELOG.md (fonte unica delle note) — adattato
// da homun2 scripts-extract-release-notes.mjs.txt. Il corpo della sezione
// `## [x.y.z] — data` finisce nel corpo della GitHub Release, da cui
// l'updater legge le "note" in-app. Nessuna release senza changelog: exit 1.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// scripts/ → radice del repo (dove sta CHANGELOG.md)
export const CHANGELOG_PATH = path.resolve(HERE, '..', 'CHANGELOG.md')

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Il corpo delle note di `version`: tutto fra l'intestazione `## [version]` e
 * la successiva `## [` (o EOF), ripulito delle definizioni di link in coda.
 * `null` se la versione non ha sezione — il chiamante lo tratta come ERRORE.
 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const headingRe = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`)
  const start = lines.findIndex((l) => headingRe.test(l))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s*\[/.test(lines[i])) {
      end = i
      break
    }
  }
  const body = lines
    .slice(start + 1, end)
    .filter((l) => !/^\[[^\]]+\]:\s*\S+/.test(l))
    .join('\n')
    .trim()
  return body || null
}

// CLI: `node extract-release-notes.mjs <versione>` → stdout (exit 1 se manca)
if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: extract-release-notes.mjs <version>')
    process.exit(2)
  }
  const notes = extractReleaseNotes(readFileSync(CHANGELOG_PATH, 'utf8'), version)
  if (!notes) {
    console.error(`Nessuna sezione per la versione ${version} in ${CHANGELOG_PATH}.`)
    process.exit(1)
  }
  process.stdout.write(notes + '\n')
}
