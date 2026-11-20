// W2 (fase avvio-finestra): il caricamento del primo avvio DICE cosa sta
// succedendo — «Sto avviando il motore di Homun…», «Aggiorno il motore alla
// versione nuova…» quando il main sa del riavvio per aggiornamento, e dopo
// 20 s senza connessione «Ci sta mettendo più del solito» col bottone
// «Riprova» che rifà la connessione. MAI una finestra vuota senza testo.
// Il modello è PURO (orologio finto nei test); il wiring di BootSplash è una
// guardia sul sorgente, come boot-splash.test.ts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bootSplashView, BOOT_SLOW_AFTER_MS } from '../lib/boot-splash-model'

const APP_SRC = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8')

describe('W2: BootSplash dice cosa sta succedendo (modello puro, orologio finto)', () => {
  it('in attesa del daemon: riga di avvio, niente «Riprova» prima dei 20 s', () => {
    expect(bootSplashView({ connected: false, restartingForUpdate: false }, 0))
      .toEqual({ line: 'starting', slow: false })
    expect(bootSplashView({ connected: false, restartingForUpdate: false }, BOOT_SLOW_AFTER_MS - 1))
      .toEqual({ line: 'starting', slow: false })
  })

  it('a 20 s senza connessione compare «Ci sta mettendo più del solito» col «Riprova»', () => {
    expect(bootSplashView({ connected: false, restartingForUpdate: false }, BOOT_SLOW_AFTER_MS))
      .toEqual({ line: 'starting', slow: true })
    expect(bootSplashView({ connected: false, restartingForUpdate: false }, BOOT_SLOW_AFTER_MS + 5_000))
      .toEqual({ line: 'starting', slow: true })
  })

  it('lo stato passa a «aggiornamento» quando c\'è il riavvio per versione (e il «Riprova» resta possibile)', () => {
    expect(bootSplashView({ connected: false, restartingForUpdate: true }, 3_000))
      .toEqual({ line: 'updating', slow: false })
    expect(bootSplashView({ connected: false, restartingForUpdate: true }, BOOT_SLOW_AFTER_MS))
      .toEqual({ line: 'updating', slow: true })
  })

  it('connesso: nessuna riga d\'attesa né «Riprova» (il caricamento è finito)', () => {
    expect(bootSplashView({ connected: true, restartingForUpdate: false }, BOOT_SLOW_AFTER_MS * 3))
      .toEqual({ line: 'starting', slow: false })
    expect(bootSplashView({ connected: true, restartingForUpdate: true }, BOOT_SLOW_AFTER_MS * 3))
      .toEqual({ line: 'starting', slow: false })
  })
})

describe('W2: il wiring di BootSplash (guardia sul sorgente di App.tsx)', () => {
  const splash = /function BootSplash\(\) \{[\s\S]*?\n\}/.exec(APP_SRC)?.[0] ?? ''

  it('le righe nuove ci sono (IT sorgente) e «Preparo tutto…» non torna', () => {
    expect(splash).toContain('Sto avviando il motore di Homun…')
    expect(splash).toContain('Aggiorno il motore alla versione nuova…')
    expect(splash).toContain('Ci sta mettendo più del solito')
    expect(splash).toContain('Riprova')
    expect(APP_SRC, 'la riga vecchia muta è via').not.toContain('Preparo tutto…')
  })

  it('il «Riprova» chiama la connessione (api.bootRetry) e RIARMa i 20 s', () => {
    expect(splash).toContain('api.bootRetry()')
    expect(splash).toMatch(/data-testid="boot-splash-retry"/)
    expect(splash, 'il conteggio riparte dall\'ultimo Riprova').toMatch(/lastRetryAt/)
  })

  it('lo splash segue il modello puro e lo stato del main (boot:status)', () => {
    expect(splash).toContain('bootSplashView')
    expect(splash).toContain('api.bootStatus()')
    expect(splash, 'il marcatore della sonda resta').toContain("dataset.bootSplashSeen = '1'")
  })
})
