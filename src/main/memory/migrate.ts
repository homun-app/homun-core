// Fase memoria-engramma (M2): la migrazione dai file markdown della fase 4
// alle note del motore Engramma. Alla PRIMA apertura del motore ogni file di
// memoria diventa una nota:
//   - cella bot-<id> (scope agent) o utente (scope user);
//   - tag core/log (il tier è un'etichetta di Homun, il motore non ha tier);
//   - source migrated:homun; confidence stated se il file era user/template,
//     inferred se era agent;
//   - createdAt/updatedAt dal file (il motore li accetta solo per una nota
//     nuova e MAI nel futuro: data storta o futura → data di OGGI e avviso);
//   - extensions x-homun { id, tier, scope, source }: ciò che Homun scrive,
//     Homun rilegge identico.
//
// IDEMPOTENTE col marcatore x-homun.id dentro la cella: prima di scrivere si
// rileggono le note esistenti e un id già migrato NON si riscrive (una
// migrazione interrotta riprende; un file rimasto al suo posto si sposta e
// basta). I file vecchi NON si cancellano: si spostano in
// <dataDir>/memory-legacy-<data>/, copia di sicurezza da cui tornare indietro.
//
// Gli avvisi portano solo ID e motivo, MAI il contenuto delle note.
import { mkdirSync, readdirSync, renameSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../store/db'
import { parseMemoryFile, memoryDir, type MemoryRecord } from '../agent/memory'
import { botCell, userCell, listAll, type EngrammaCell } from './engine'

export interface MigrationSummary {
  migrated: number
  /** id e motivo, mai contenuti */
  warnings: string[]
  /** la copia di sicurezza dei file spostati (null se niente da migrare) */
  backupDir: string | null
  durationMs: number
}

/** RFC 3339 per il motore; le date del file sono epoca ms. */
function toRfc3339(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * La data buona per la nota: quella del file se è sensata (finita e non nel
 * futuro, coi 5 minuti di tolleranza del motore), altrimenti oggi.
 */
function migrationDate(ms: number, now: number, toleranceMs = 5 * 60_000): { value: number; corrected: boolean } {
  if (Number.isFinite(ms) && ms > 0 && ms <= now + toleranceMs) return { value: ms, corrected: false }
  return { value: now, corrected: true }
}

function readRecords(dir: string): Array<{ file: string; record: MemoryRecord | null }> {
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return [] // directory assente: niente da migrare
  }
  return names.map((file) => ({ file, record: parseMemoryFile(readFileSync(join(dir, file), 'utf8')) }))
}

/**
 * Migra TUTTI i file di memoria degli agenti dati (più le memorie condivise
 * user). Non lancia mai: un problema di un file è un avviso, il resto va
 * avanti; la prossima apertura riprova ciò che è rimasto. Correzioni C6:
 * OGNI file nel suo try/catch — un put rifiutato o un rename fallito non
 * ferma né i file dopo né gli agenti dopo (prima l'eccezione saliva e la
 * migrazione si ripeteva uguale a ogni avvio, bloccando chi veniva dopo).
 */
export async function migrateLegacyMemories(
  agentIds: string[],
  opts: { now?: () => number; openCell?: (agentId: string, scope: 'agent' | 'user') => Promise<EngrammaCell> } = {}
): Promise<MigrationSummary> {
  const t0 = Date.now()
  const now = (opts.now ?? Date.now)()
  const warnings: string[] = []
  let migrated = 0
  let backupDir: string | null = null

  const ensureBackup = (): string => {
    if (!backupDir) backupDir = join(dataDir(), 'memory-legacy-' + new Date(now).toISOString().slice(0, 10))
    return backupDir
  }
  const backupOf = (record: MemoryRecord, agentId: string): string => {
    const rel = record.scope === 'user'
      ? join('user', 'memory')
      : join('agents', agentId, 'memory')
    const dir = join(ensureBackup(), rel)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  for (const agentId of agentIds) {
    for (const scope of ['agent', 'user'] as const) {
      const dir = memoryDir(agentId, scope)
      const entries = readRecords(dir)
      if (!entries.length) continue
      // la cella giusta: bot-<id> per lo scope agent, utente per lo user
      // (la migrazione della cella utente scrive con l'actor dell'interfaccia)
      const cell = opts.openCell
        ? await opts.openCell(agentId, scope)
        : scope === 'user' ? await userCell(null) : await botCell(agentId)
      // marcatore: gli x-homun.id GIÀ nella cella non si riscrivono (correzioni
      // C5: a pagine — il vecchio limit enorme si fermava al tetto del motore)
      const existing = new Set(
        (await listAll(cell))
          .map((n) => (n.extensions['x-homun'] as { id?: string } | undefined)?.id)
          .filter((id): id is string => typeof id === 'string')
      )
      const seen = new Set<string>()
      for (const { file, record } of entries) {
        // correzioni C6: ogni file nel suo try/catch — l'avviso porta il nome
        // del file e il CODICE d'errore, mai il contenuto; il file resta al
        // suo posto e il prossimo avvio riprova
        try {
          if (!record) {
            warnings.push(`${file}: malformed memory file, skipped`)
            // si sposta anche lui nella copia di sicurezza (i file vecchi non
            // si cancellano) così il prossimo avvio non riavverte. La cartella
            // si CREA prima del rename (correzioni C6: backupOf non era ancora
            // mai passato e renameSync faceva ENOENT, fermando tutto)
            const dest = join(ensureBackup(), scope === 'user' ? join('user', 'memory') : join('agents', agentId, 'memory'), file)
            mkdirSync(dirname(dest), { recursive: true })
            renameSync(join(dir, file), dest)
            continue
          }
          if (existing.has(record.id)) {
            // già migrato (migrazione interrotta): si sposta e basta
            renameSync(join(dir, file), join(backupOf(record, agentId), file))
            continue
          }
          if (seen.has(record.id)) {
            warnings.push(`${file}: duplicate id ${record.id} in the same cell, skipped`)
            // anche il DOPPIO in copia di sicurezza (correzioni C6): restando
            // al suo posto si riavvertirebbe a ogni avvio
            renameSync(join(dir, file), join(backupOf(record, agentId), file))
            continue
          }
          seen.add(record.id)
          const created = migrationDate(record.createdAt || record.updatedAt, now)
          const updated = migrationDate(record.updatedAt || record.createdAt, now)
          if (created.corrected) warnings.push(`${file}: created_at invalid or in the future, migrated with today's date`)
          if (updated.corrected) warnings.push(`${file}: updated_at invalid or in the future, migrated with today's date`)
          await cell.put({
            body: record.content,
            tags: [record.tier],
            source: 'migrated:homun',
            confidence: record.source === 'user' || record.source === 'template' ? 'stated' : 'inferred',
            extensions: { 'x-homun': { id: record.id, tier: record.tier, scope: record.scope, source: record.source } },
            createdAt: toRfc3339(created.value),
            updatedAt: toRfc3339(updated.value)
          })
          migrated++
          // il file NON si cancella: si sposta nella copia di sicurezza
          renameSync(join(dir, file), join(backupOf(record, agentId), file))
        } catch (e) {
          const code = (e as { code?: string })?.code ?? 'error'
          warnings.push(`${file}: ${code}, skipped (next boot retries)`)
        }
      }
    }
  }
  return { migrated, warnings, backupDir, durationMs: Date.now() - t0 }
}
