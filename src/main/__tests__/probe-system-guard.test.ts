// Fase primo-avvio (sonda): l'app IMPACCHETTATA di prova gira con
// SANDBOT_TEST_USER_DATA su una cartella temporanea. Fino a qui, a ogni
// avvio, anche nelle prove, l'app si registrava come gestore dello schema
// sandbot:// (app.setAsDefaultProtocolClient): una copia di prova in una
// cartella temporanea prendeva il posto di quella vera FINCHÉ l'app vera
// non si riavviava (e intanto la copia di prova veniva cancellata). Il
// principio di A8 è che le prove non tocchino il Mac dell'utente: sotto
// SANDBOT_TEST_USER_DATA la registrazione si salta.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registersProtocolClient } from '../mode'

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')

describe('fase primo-avvio: le prove con l\'app impacchettata non cambiano il Mac dell\'utente', () => {
  it('di norma (produzione) l\'app si registra come gestore di sandbot://', () => {
    expect(registersProtocolClient({})).toBe(true)
    expect(registersProtocolClient({ SANDBOT_DATA_DIR: '/x' })).toBe(true)
  })

  it('con SANDBOT_TEST_USER_DATA NON si registra (la copia di prova non prende il posto di quella vera)', () => {
    expect(registersProtocolClient({ SANDBOT_TEST_USER_DATA: '/T/sonda' })).toBe(false)
  })

  it('index.ts chiama setAsDefaultProtocolClient solo quando registersProtocolClient lo dice (guardia sul sorgente)', () => {
    const call = INDEX.indexOf("app.setAsDefaultProtocolClient('sandbot')")
    expect(call, 'la registrazione c\'è').toBeGreaterThan(-1)
    const guard = INDEX.slice(INDEX.lastIndexOf('if (', call), call)
    expect(guard).toBe('if (registersProtocolClient(process.env)) ')
  })
})
