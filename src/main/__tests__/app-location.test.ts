// RV1 (fase beta.2): l'app eseguita fuori da Applicazioni o in sola lettura
// (App Translocation). Qui le funzioni PURE: la decisione appLocationAction,
// il flusso di spostamento con il gestore dei conflitti (tutto iniettato:
// dialoghi, sposta, stop del daemon) e la risposta esplicita del controllo
// aggiornamenti quando serve lo spostamento.
import { describe, expect, it } from 'vitest'
import {
  appLocationAction,
  isAppTranslocatedPath,
  moveToApplicationsFlow,
  updateCheckResultWhenMoveNeeded,
  type MoveToApplicationsDeps
} from '../app-location'

const DARWIN: AppLocationCase = { isPackaged: true, platform: 'darwin', inAppsFolder: true, updaterEnabled: true, execPath: '/Applications/Homun.app/Contents/MacOS/Homun' }
type AppLocationCase = Parameters<typeof appLocationAction>[0]

const TRANSLOCATED = '/private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/AppTranslocation/d/Homun.app/Contents/MacOS/Homun'

describe('RV1: la decisione è una funzione pura', () => {
  it('macOS impacchettata con updater, DENTRO Applicazioni → ok', () => {
    expect(appLocationAction(DARWIN)).toBe('ok')
  })

  it('macOS impacchettata FUORI Applicazioni (Downloads, dmg) → ask-move', () => {
    expect(appLocationAction({ ...DARWIN, inAppsFolder: false, execPath: '/Users/fabio/Downloads/Homun.app/Contents/MacOS/Homun' })).toBe('ask-move')
  })

  it('percorso di App Translocation → ask-move, anche se inAppsFolder dicesse sì (copia read-only)', () => {
    expect(appLocationAction({ ...DARWIN, execPath: TRANSLOCATED })).toBe('ask-move')
    expect(appLocationAction({ ...DARWIN, inAppsFolder: false, execPath: TRANSLOCATED })).toBe('ask-move')
    expect(isAppTranslocatedPath(TRANSLOCATED)).toBe(true)
    expect(isAppTranslocatedPath('/Applications/Homun.app/Contents/MacOS/Homun')).toBe(false)
  })

  it('test env, build --dir, dev (updater spento: shouldAutoCheckUpdates/hasUpdateConfig già deciso) → skip', () => {
    // le condizioni NON si ricalcolano: updaterEnabled false copre SANDBOT_TEST_*,
    // --dir senza app-update.yml e lo sviluppo
    expect(appLocationAction({ ...DARWIN, isPackaged: false, updaterEnabled: false })).toBe('skip')
    expect(appLocationAction({ ...DARWIN, inAppsFolder: false, updaterEnabled: false })).toBe('skip')
  })

  it('Linux e Windows → skip (il controllo è solo per macOS)', () => {
    expect(appLocationAction({ ...DARWIN, platform: 'linux', inAppsFolder: false })).toBe('skip')
    expect(appLocationAction({ ...DARWIN, platform: 'win32', inAppsFolder: false })).toBe('skip')
  })
})

/**
 * Le dipendenze finte del flusso: dialoghi, sposta e stop del daemon. Ogni
 * dipendenza REGISTRA la sua chiamata; `over` sostituisce il comportamento
 * (il valore di ritorno, i conflitti da dichiarare) senza perdere la traccia.
 */
function makeDeps(over: Partial<MoveToApplicationsDeps> & Record<string, unknown> = {}) {
  const calls: string[] = []
  const deps: MoveToApplicationsDeps = {
    askMove: async () => {
      calls.push('ask-move')
      return (over.askMove as () => Promise<boolean>)?.() ?? true
    },
    confirmReplace: () => {
      calls.push('confirm-replace')
      return true
    },
    moveToApplications: (conflictHandler) => {
      calls.push(`move(${calls.includes('daemon-stopped') ? 'dopo-stop' : 'prima'})`)
      const custom = over.moveToApplications as ((h: (t: 'exists' | 'existsAndRunning') => boolean) => boolean) | undefined
      return custom ? custom(conflictHandler) : true
    },
    stopDaemon: async () => {
      calls.push('daemon-stopped')
      return true
    },
    reportFailure: (message) => { calls.push(`failure:${message}`) },
    reportError: (message) => { calls.push(`failure:${message}`) }
  }
  // i sovrascritti espliciti vincono sul comportamento di default (confirm
  // negato, daemon non fermabile, …) e mantengono la registrazione
  if (over.confirmReplace) {
    const custom = over.confirmReplace as () => boolean
    deps.confirmReplace = () => { calls.push('confirm-replace'); return custom() }
  }
  if (over.stopDaemon) {
    const custom = over.stopDaemon as () => Promise<boolean>
    deps.stopDaemon = async () => { calls.push('daemon-stopped'); return custom() }
  }
  if (over.moveToApplications) {
    const custom = over.moveToApplications as (h: (t: 'exists' | 'existsAndRunning') => boolean) => boolean
    deps.moveToApplications = (h) => {
      calls.push(`move(${calls.includes('daemon-stopped') ? 'dopo-stop' : 'prima'})`)
      return custom(h)
    }
  }
  return { deps, calls }
}

describe('RV1: il flusso di spostamento (dialoghi e sposta iniettati)', () => {
  it('«Non ora» al primo dialogo: nessuno spostamento, nessun conflitto', async () => {
    const { deps, calls } = makeDeps({ askMove: async () => false })
    expect(await moveToApplicationsFlow(deps)).toBe('declined')
    expect(calls).toEqual(['ask-move'])
  })

  it('conflitto exists: si chiede conferma («Sostituisci la versione in Applicazioni?») e si sposta', async () => {
    const { deps, calls } = makeDeps({
      moveToApplications: (h) => { h('exists'); return true }
    })
    expect(await moveToApplicationsFlow(deps)).toBe('moved')
    expect(calls).toEqual(['ask-move', 'move(prima)', 'confirm-replace'])
  })

  it('conflitto exists con conferma NEGATA: niente spostamento, e non si tocca il daemon', async () => {
    const { deps, calls } = makeDeps({
      confirmReplace: () => false,
      moveToApplications: (h) => { h('exists'); return false }
    })
    expect(await moveToApplicationsFlow(deps)).toBe('not-moved')
    expect(calls).toEqual(['ask-move', 'move(prima)', 'confirm-replace'])
  })

  it('conflitto existsAndRunning: PRIMA si ferma il daemon (il meccanismo dell’updater), POSI si riprova', async () => {
    let attempt = 0
    const { deps, calls } = makeDeps({
      moveToApplications: (h) => {
        attempt++
        if (attempt === 1) { h('existsAndRunning'); return false }
        h('exists')
        return true
      }
    })
    expect(await moveToApplicationsFlow(deps)).toBe('moved')
    expect(calls).toEqual(['ask-move', 'move(prima)', 'daemon-stopped', 'move(dopo-stop)', 'confirm-replace'])
  })

  it('existsAndRunning con daemon NON fermabile: non si sostituisce MAI un’app che gira — messaggio chiaro', async () => {
    const { deps, calls } = makeDeps({
      stopDaemon: async () => { calls.push('daemon-stopped'); return false },
      moveToApplications: (h) => { h('existsAndRunning'); return false }
    })
    expect(await moveToApplicationsFlow(deps)).toBe('daemon-not-stopped')
    expect(calls.filter((c) => c.startsWith('failure:')).length).toBe(1)
    expect(calls.filter((c) => c === 'move(prima)').length).toBe(1) // UN solo tentativo
  })

  it('existsAndRunning, daemon fermato, ma in Applicazioni gira ANCORA qualcosa: si annulla col messaggio chiaro', async () => {
    let attempt = 0
    const { deps, calls } = makeDeps({
      moveToApplications: (h) => { attempt++; h(attempt === 1 ? 'existsAndRunning' : 'existsAndRunning'); return false }
    })
    expect(await moveToApplicationsFlow(deps)).toBe('still-running')
    expect(calls.filter((c) => c.startsWith('failure:')).length).toBe(1)
  })

  it('moveToApplicationsFolder che LANCIA (copertura fallita): l’errore arriva all’utente, esito not-moved', async () => {
    const { deps, calls } = makeDeps({
      moveToApplications: () => { throw new Error('Failed to copy application to applications directory') }
    })
    expect(await moveToApplicationsFlow(deps)).toBe('not-moved')
    expect(calls.some((c) => c.startsWith('failure:'))).toBe(true)
  })

  it('la conferma della sostituzione si chiede UNA volta sola (non di nuovo alla riprova)', async () => {
    let attempt = 0
    let asked = 0
    const { deps, calls } = makeDeps({
      confirmReplace: () => { asked++; return true },
      moveToApplications: (h) => {
        attempt++
        if (attempt === 1) { h('existsAndRunning'); return false }
        h('exists')
        return true
      }
    })
    expect(await moveToApplicationsFlow(deps)).toBe('moved')
    expect(asked).toBe(1)
    expect(calls).toEqual(['ask-move', 'move(prima)', 'daemon-stopped', 'move(dopo-stop)', 'confirm-replace'])
  })
})

describe('RV1: «Controlla aggiornamenti» non fallisce in silenzio', () => {
  it('quando serve lo spostamento il controllo risponde esplicitamente needsMove', () => {
    expect(updateCheckResultWhenMoveNeeded('0.3.1001-beta.2')).toEqual({
      current: '0.3.1001-beta.2', available: false, version: null, needsMove: true
    })
  })
})
