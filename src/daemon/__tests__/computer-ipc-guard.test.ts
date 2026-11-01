// Fase 19b (T6): i canali dei FILE che toccano il Mac si raggiungono SOLO dal
// main, dopo il dialog. Il canale inoltrato alla UI è files:list/files:read
// (e terminal:open / activity:*); files:export e files:import NON sono tra i
// DAEMON_RPC_CHANNELS (li chiama il main con client.call dopo «Salva»/«Apri»)
// e il preload NON espone un exportTo(path) libero — solo filesDownload /
// filesUpload (che aprono i dialog) e filesImportDropped (il trascinamento,
// col path del drop). Test di TESTO sui sorgenti: niente import di electron.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const ipc = readFileSync('src/main/ipc.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')

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
