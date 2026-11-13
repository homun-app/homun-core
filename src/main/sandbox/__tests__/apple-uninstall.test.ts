// OB5 (fase onboarding-b): togliere lo strumento di Apple — la guardia sullo
// script di disinstallazione di Apple (esiste, è di root:wheel, NON è
// scrivibile da gruppo o altri) e il comando osascript FISSO (una costante,
// mai composto con dati). Lo script che non rispetta la guardia → niente
// osascript, errore in parole: la password del Mac non si dà a un file
// che chiunque può riscrivere.
import { describe, expect, it } from 'vitest'
import {
  uninstallScriptGuardOk, UNINSTALL_OSASCRIPT_ARGV, UNINSTALL_CONTAINER_SCRIPT
} from '../apple-uninstall'

const okStat = { exists: true, uid: 0, gid: 0, mode: 0o755 }

describe('OB5: la guardia sullo script di disinstallazione (pura)', () => {
  it('lo script di Apple, di root:wheel, non scrivibile da gruppo o altri: si può', () => {
    expect(uninstallScriptGuardOk(okStat)).toEqual({ ok: true, reason: null })
    expect(uninstallScriptGuardOk({ ...okStat, mode: 0o700 })).toEqual({ ok: true, reason: null })
    expect(uninstallScriptGuardOk({ ...okStat, mode: 0o555 })).toEqual({ ok: true, reason: null })
  })

  it('script ASSENTE → niente osascript', () => {
    expect(uninstallScriptGuardOk({ ...okStat, exists: false })).toEqual({ ok: false, reason: 'missing' })
    expect(uninstallScriptGuardOk(null)).toEqual({ ok: false, reason: 'missing' })
  })

  it('script NON di root (o non di wheel) → niente osascript', () => {
    expect(uninstallScriptGuardOk({ ...okStat, uid: 501 })).toEqual({ ok: false, reason: 'not-root' })
    expect(uninstallScriptGuardOk({ ...okStat, gid: 20 })).toEqual({ ok: false, reason: 'not-root' })
    expect(uninstallScriptGuardOk({ ...okStat, uid: 501, gid: 20 })).toEqual({ ok: false, reason: 'not-root' })
  })

  it('script SCRIVIBILE da gruppo o da altri → niente osascript (chiunque potrebbe riscriverlo)', () => {
    expect(uninstallScriptGuardOk({ ...okStat, mode: 0o775 })).toEqual({ ok: false, reason: 'writable' })
    expect(uninstallScriptGuardOk({ ...okStat, mode: 0o757 })).toEqual({ ok: false, reason: 'writable' })
    expect(uninstallScriptGuardOk({ ...okStat, mode: 0o777 })).toEqual({ ok: false, reason: 'writable' })
  })
})

describe('OB5: il comando osascript è una COSTANTE, mai composto con dati', () => {
  it('argv fisso: -e e l\'unica stringa do shell script … with administrator privileges', () => {
    expect(UNINSTALL_OSASCRIPT_ARGV).toEqual(['-e', 'do shell script "/usr/local/bin/uninstall-container.sh -d" with administrator privileges'])
  })

  it('lo script è quello di Apple in /usr/local/bin', () => {
    expect(UNINSTALL_CONTAINER_SCRIPT).toBe('/usr/local/bin/uninstall-container.sh')
  })
})
