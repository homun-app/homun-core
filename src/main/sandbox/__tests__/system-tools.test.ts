// OBR1 (fase onboarding-b-rafforzamenti): gli strumenti di sistema si
// chiamano col loro PERCORSO ASSOLUTO, mai per nome — un PATH con cartelle
// scrivibili dall'utente (Homebrew, ~/bin) potrebbe mettere davanti un falso
// pkgutil o spctl che dice sempre OK, o un falso osascript con una sua
// finestra per la password. Le quattro costanti stanno in UN modulo (questo
// test le blocca), la configurazione di produzione usa SOLO quelle, e una
// guardia sui sorgenti vieta le chiamate per nome nei punti di produzione.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SYSTEM_PKGUTIL, SYSTEM_SPCTL, SYSTEM_OPEN, SYSTEM_OSASCRIPT } from '../system-tools'
import { boxSetupRunConfig } from '../../../daemon/box-setup'

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('OBR1: le quattro costanti, bloccate', () => {
  it('pkgutil, spctl, open e osascript col percorso di sistema', () => {
    expect(SYSTEM_PKGUTIL).toBe('/usr/sbin/pkgutil')
    expect(SYSTEM_SPCTL).toBe('/usr/sbin/spctl')
    expect(SYSTEM_OPEN).toBe('/usr/bin/open')
    expect(SYSTEM_OSASCRIPT).toBe('/usr/bin/osascript')
  })
})

describe('OBR1: la configurazione di produzione ha i percorsi assoluti', () => {
  const overrides = {
    SANDBOT_TEST_OPEN: '/bin/finto-open',
    SANDBOT_TEST_PKGUTIL: '/bin/finto-pkgutil',
    SANDBOT_TEST_SPCTL: '/bin/finto-spctl'
  }

  it('app impacchettata: SOLO le costanti, gli override SANDBOT_TEST_* ignorati', () => {
    const c = boxSetupRunConfig(overrides, true)
    expect(c.openCmd).toBe('/usr/bin/open')
    expect(c.pkgutilPath).toBe('/usr/sbin/pkgutil')
    expect(c.spctlPath).toBe('/usr/sbin/spctl')
  })

  it('senza override (sviluppo): le stesse costanti, mai un nome da cercare nel PATH', () => {
    const c = boxSetupRunConfig({}, false)
    expect(c.openCmd).toBe('/usr/bin/open')
    expect(c.pkgutilPath).toBe('/usr/sbin/pkgutil')
    expect(c.spctlPath).toBe('/usr/sbin/spctl')
  })

  it('gli override di prova restano (non impacchettata)', () => {
    const c = boxSetupRunConfig(overrides, false)
    expect(c.openCmd).toBe('/bin/finto-open')
    expect(c.pkgutilPath).toBe('/bin/finto-pkgutil')
    expect(c.spctlPath).toBe('/bin/finto-spctl')
  })
})

describe('OBR1: nessuna chiamata per nome nei punti di produzione (guardia sui sorgenti)', () => {
  const BOX_SETUP = src('../../../daemon/box-setup.ts')
  const RUNTIME = src('../../../daemon/runtime.ts')
  const API = src('../../../daemon/api.ts')

  it('box-setup.ts: i comandi della configurazione vengono dalle costanti', () => {
    for (const name of ['open', 'pkgutil', 'spctl']) {
      // né come ripiego di un override, né come valore di un campo
      expect(BOX_SETUP, name).not.toContain(`?? '${name}'`)
      expect(BOX_SETUP, name).not.toMatch(new RegExp(`(openCmd|pkgutilPath|spctlPath):\\s*'${name}'`))
    }
    expect(BOX_SETUP).toContain('SYSTEM_OPEN')
    expect(BOX_SETUP).toContain('SYSTEM_PKGUTIL')
    expect(BOX_SETUP).toContain('SYSTEM_SPCTL')
  })

  it("runtime.ts: l'Installer si apre col comando della configurazione, mai con «open» per nome", () => {
    expect(RUNTIME).toContain("execFile(boxSetupRunConfig().openCmd, ['-a', 'Installer', pkgPath]")
    expect(RUNTIME).not.toMatch(/execFile\(\s*'open'/)
  })

  it('api.ts: la disinstallazione chiama osascript con la costante, mai per nome', () => {
    expect(API).not.toMatch(/runCli\(\s*'osascript'/)
    expect(API).toContain('.runCli(SYSTEM_OSASCRIPT, [...u.UNINSTALL_OSASCRIPT_ARGV]')
  })
})
