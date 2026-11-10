// Fase CI test ermetici (RU1): il REPORT si AGGIUNGE in cima, mai
// sostituire — e l'invariante si verifica SENZA git. Il test di prima faceva
// `git show a6aa41ee:REPORT.md`, che in CI (actions/checkout@v4, profondità 1)
// crasciava: il commit non esiste e la storia git non è codice sotto test.
// L'invariante resta identico: la coda di REPORT.md è, BYTE PER BYTE, il
// REPORT.md di a6aa41ee (l'ultimo commit che lo aveva intero, tag
// fase-memoria-engramma-correzioni-2). Qui il valore atteso è FISSATO nel
// test, ricalcolato da `git show a6aa41ee:REPORT.md` prima di fissarlo:
//   lunghezza 1 449 562 byte
//   sha256 82510977d59495314566fb4fab8ae3197335e9229ad2c89a8ec7df133c0c19a5
//   53 intestazioni «^# REPORT»
// Con questo schema nella coda conta anche un solo byte cambiato: lo sha256
// non torna. NESSUNA copia del vecchio file come fixture (1,4 MB duplicati):
// la funzione pura riceve il Buffer, così il caso «un byte cambiato» si prova
// su una copia del file CORRENTE. Mai skip silenzioso se manca qualcosa: il
// file più corto della coda, o mancante, è un test ROSSO.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')

/** il REPORT.md di a6aa41ee com'era, FISSATO (la CI non ha la storia git) */
const A6AA41EE_LEN = 1_449_562
const A6AA41EE_SHA256 = '82510977d59495314566fb4fab8ae3197335e9229ad2c89a8ec7df133c0c19a5'
const A6AA41EE_HEADERS = 53

const countReportHeaders = (s: string): number => (s.match(/^# REPORT/gm) ?? []).length

/**
 * Funzione PURA: controlla che la coda di `buf` (gli ultimi A6AA41EE_LEN
 * byte) sia il REPORT.md di a6aa41ee. Riceve il Buffer, non il percorso, così
 * si può provare anche su una copia con un byte cambiato, senza tenere in
 * giro una fixture da 1,4 MB. `ok` falso → i `problems` dicono il perché.
 */
function checkReportTail(buf: Buffer): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  if (buf.length < A6AA41EE_LEN) {
    problems.push(`il file (${buf.length} byte) è più CORTO della coda attesa (${A6AA41EE_LEN} byte)`)
    return { ok: false, problems }
  }
  const tail = buf.subarray(buf.length - A6AA41EE_LEN)
  const sha = createHash('sha256').update(tail).digest('hex')
  if (sha !== A6AA41EE_SHA256) problems.push(`lo sha256 della coda è ${sha}, atteso ${A6AA41EE_SHA256}`)
  const tailHeaders = countReportHeaders(tail.toString('utf8'))
  if (tailHeaders !== A6AA41EE_HEADERS) {
    problems.push(`la coda ha ${tailHeaders} intestazioni «^# REPORT», attese ${A6AA41EE_HEADERS}`)
  }
  const wholeHeaders = countReportHeaders(buf.toString('utf8'))
  if (wholeHeaders < A6AA41EE_HEADERS + 1) {
    problems.push(`il file intero ha ${wholeHeaders} intestazioni «^# REPORT», attese almeno ${A6AA41EE_HEADERS + 1}`)
  }
  return { ok: problems.length === 0, problems }
}

describe('fase CI test ermetici (RU1): il REPORT non si sostituisce, senza git', () => {
  it('la coda di REPORT.md è il REPORT.md di a6aa41ee, byte per byte (valori fissati)', () => {
    const r = checkReportTail(readFileSync(join(REPO, 'REPORT.md')))
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('un SOLO byte cambiato nella coda viene VISTO: lo sha256 non torna', () => {
    const buf = Buffer.from(readFileSync(join(REPO, 'REPORT.md'))) // copia modificabile
    // un byte DENTRO la coda (a metà degli ultimi A6AA41EE_LEN byte)
    const at = buf.length - Math.floor(A6AA41EE_LEN / 2)
    buf[at] = buf[at] === 0x41 ? 0x42 : 0x41
    const r = checkReportTail(buf)
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/sha256/)
  })
})
