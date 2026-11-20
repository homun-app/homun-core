// W2 (fase avvio-finestra), trovato DALL VIVO dalla sonda: main.tsx montava
// l'app SOLO dopo settingsGet('ui.language') — un RPC al daemon. Col daemon
// in riavvio per aggiornamento quella RPC sta appesa SECONDI e la finestra
// restava VUOTA (niente splash, niente testo: proprio ciò che W2 vieta).
// Qui la parte pura del rimedio: il setting si aspetta poco, poi si monta con
// la lingua di sistema; quando il setting arriva si riattiva a caldo.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bootLanguageSetting, laterBootLanguage, BOOT_LANG_WAIT_MS } from '../lib/boot-language'

const MAIN_SRC = readFileSync(fileURLToPath(new URL('../main.tsx', import.meta.url)), 'utf8')

describe('W2: la lingua di avvio non tiene vuota la finestra', () => {
  it('il setting risponde subito → si usa lui', async () => {
    const setting = await bootLanguageSetting(async () => 'en')
    expect(setting).toBe('en')
  })

  it('il daemon non risponde (riavvio per aggiornamento) → dopo BOOT_LANG_WAIT_MS si parte con «system»', async () => {
    vi.useFakeTimers()
    const never = new Promise(() => undefined) as never as Promise<'system'>
    const p = bootLanguageSetting(() => never)
    await vi.advanceTimersByTimeAsync(BOOT_LANG_WAIT_MS + 10)
    expect(await p).toBe('system')
    vi.useRealTimers()
  })

  it('un errore del setting non blocca: si parte con «system»', async () => {
    const setting = await bootLanguageSetting(async () => { throw new Error('daemon giù') })
    expect(setting).toBe('system')
  })

  it('il setting che arriva DOPO cambia la lingua solo se diversa da quella usata al mount', () => {
    expect(laterBootLanguage('it', 'en', ['it'])).toBe('en')
    expect(laterBootLanguage('it', 'system', ['it'])).toBeNull()
    expect(laterBootLanguage('en', 'en', ['it'])).toBeNull()
  })

  it('main.tsx monta senza aspettare il setting all\'infinito (guardia sul sorgente)', () => {
    expect(MAIN_SRC).toContain('bootLanguageSetting')
    expect(MAIN_SRC).toContain('laterBootLanguage')
    expect(MAIN_SRC, 'il render non aspetta il secondo settingsGet').toMatch(/createRoot[\s\S]*?\.render\(/)
  })
})
