// Fase 19b (T6): i canali dei FILE che toccano il Mac si raggiungono SOLO dal
// main, dopo il dialog. Il canale inoltrato alla UI è files:list/files:read
// (e terminal:open / activity:*); files:export e files:import NON sono tra i
// DAEMON_RPC_CHANNELS (li chiama il main con client.call dopo «Salva»/«Apri»)
// e il preload NON espone un exportTo(path) libero — solo filesDownload /
// filesUpload (che aprono i dialog) e filesImportDropped (il trascinamento,
// col path del drop). Test di TESTO sui sorgenti: niente import di electron.
//
// Fase 19b correzioni (U1): il path del trascinamento lo calcola SOLO il
// preload dall'oggetto File del drop — nessun metodo accetta (o rivela) una
// stringa col path del Mac scelta dal renderer.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const ipc = readFileSync('src/main/ipc.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')

/** Il blocco DAEMON_RPC_CHANNELS di ipc.ts (i canali inoltrati 1:1 alla UI). */
function daemonRpcChannels(src: string): string[] {
  const body = /export const DAEMON_RPC_CHANNELS = \[([\s\S]*?)\] as const/.exec(src)?.[1] ?? ''
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('fase 19b (T6): files:export e files:import SOLO dal main, mai inoltrati alla UI', () => {
  it('i canali della UI: files:list e files:read SÌ, files:export e files:import NO', () => {
    const channels = daemonRpcChannels(ipc)
    expect(channels).toContain('files:list')
    expect(channels).toContain('files:read')
    expect(channels).toContain('terminal:open')
    expect(channels).toContain('activity:list')
    expect(channels).toContain('activity:output')
    expect(channels).not.toContain('files:export')
    expect(channels).not.toContain('files:import')
  })

  it('il main chiama files:export/files:import SOLO dentro gli handler dei DIALOG (files:download / files:upload) e del trascinamento', () => {
    // le uniche chiamate ai metodi delicati sono nelle finestre del Mac
    const callSites = ipc.split("client.call('files:export'").length - 1
      + ipc.split("client.call('files:import'").length - 1
    expect(callSites).toBeGreaterThan(0) // il main li usa (dopo il dialog)…
    // …ma NESSUN ipcMain.handle espone 'files:export' o 'files:import' diretti
    expect(ipc).not.toMatch(/ipcMain\.handle\('files:export'/)
    expect(ipc).not.toMatch(/ipcMain\.handle\('files:import',/)
    // gli handler locali della UI sono questi tre
    expect(ipc).toMatch(/ipcMain\.handle\('files:download'/)
    expect(ipc).toMatch(/ipcMain\.handle\('files:upload'/)
    expect(ipc).toMatch(/ipcMain\.handle\('files:import-dropped'/)
  })

  it('il preload NON espone un exportTo(path) libero: solo i dialog e il trascinamento', () => {
    expect(preload).toContain('filesDownload:')
    expect(preload).toContain('filesUpload:')
    expect(preload).toContain('filesImportDropped:')
    expect(preload).toContain('webUtils.getPathForFile')
    // nessun metodo che scriva/legga un path del Mac scelto dal renderer
    for (const banned of ['exportTo', 'importFrom', 'macPathOf', 'writeMacFile', 'readMacFile']) {
      expect(preload).not.toContain(banned)
    }
    // e il preload non inoltra MAI i canali delicati
    expect(preload).not.toContain("'files:export'")
    expect(preload).not.toContain("'files:import'")
  })
})

describe('fase 19b correzioni (U1): il path del trascinamento lo calcola SOLO il preload', () => {
  /** Il blocco della proprietà filesImportDropped del preload. */
  const droppedBlock = () => /filesImportDropped: \(([\s\S]*?)\n  \},/.exec(preload)?.[0] ?? ''

  it('pathForFile non c\'è più: nessun metodo del preload rivela un path del Mac', () => {
    expect(preload).not.toContain('pathForFile')
    expect(types).not.toContain('pathForFile')
  })

  it('filesImportDropped prende un FILE (non una stringa) e calcola il path DENTRO, col webUtils', () => {
    const block = droppedBlock()
    expect(block).toMatch(/filesImportDropped: \(agentId, dirPath, file, overwrite\)/)
    // il path nasce QUI, dall'oggetto File del drop…
    expect(block).toContain('webUtils.getPathForFile(file)')
    // …e l'invoke passa quella variabile, mai un parametro del renderer
    expect(block).toMatch(/ipcRenderer\.invoke\('files:import-dropped', agentId, dirPath, \w+, overwrite\)/)
    // il tipo pubblico accetta un File
    expect(types).toMatch(/filesImportDropped\(agentId: string, dirPath: string, file: File, overwrite\?: boolean\)/)
  })

  it('un File senza path (costruito dalla pagina) è rifiutato PRIMA di chiamare il main', () => {
    const block = droppedBlock()
    expect(block).toContain("Promise.reject(new Error('not a dropped file'))")
    // il rifiuto viene prima dell'invoke: col path vuoto il main non si tocca
    expect(block.indexOf('Promise.reject')).toBeLessThan(block.indexOf('ipcRenderer.invoke'))
  })

  it('nessun metodo del preload accetta una stringa macPath dal renderer', () => {
    // né come parametro, né come nome locale: l'identificatore non esiste
    expect(preload).not.toContain('macPath')
    // e la CHIAMATA a webUtils.getPathForFile compare UNA volta sola, DENTRO
    // il blocco del trascinamento: fuori da lì nessun metodo calcola o
    // rivela un path del Mac
    expect(preload.split('webUtils.getPathForFile(').length - 1).toBe(1)
    expect(droppedBlock()).toContain('webUtils.getPathForFile(file)')
  })
})
