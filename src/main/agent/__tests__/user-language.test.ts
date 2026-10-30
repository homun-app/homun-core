// Fase 17b (A2): precedenza di currentUserLanguage e aggiornamento di
// noteHumanText, sullo store reale in una directory temporanea; più il test
// del main che pubblica 'ui.activeLanguage' (payload della chiamata).
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-user-language-test-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('fase 17b (A2): currentUserLanguage', () => {
  it('senza setting il ripiego è en', async () => {
    const { setDataDir, deleteSetting } = await import('../../store/db')
    const { currentUserLanguage } = await import('../user-language')
    setDataDir(join(root, 'a'))
    deleteSetting('agent.userLanguage')
    deleteSetting('ui.activeLanguage')
    expect(currentUserLanguage()).toBe('en')
  })

  it('agent.userLanguage vince su ui.activeLanguage', async () => {
    const { setDataDir, setSetting } = await import('../../store/db')
    const { currentUserLanguage } = await import('../user-language')
    setDataDir(join(root, 'b'))
    setSetting('ui.activeLanguage', 'it')
    setSetting('agent.userLanguage', 'en')
    expect(currentUserLanguage()).toBe('en')
  })

  it('ui.activeLanguage vale quando non c\'è lingua rilevata', async () => {
    const { setDataDir, setSetting, deleteSetting } = await import('../../store/db')
    const { currentUserLanguage } = await import('../user-language')
    setDataDir(join(root, 'c'))
    deleteSetting('agent.userLanguage')
    setSetting('ui.activeLanguage', 'it')
    expect(currentUserLanguage()).toBe('it')
  })

  it('un setting non valido si ignora', async () => {
    const { setDataDir, setSetting, deleteSetting } = await import('../../store/db')
    const { currentUserLanguage } = await import('../user-language')
    setDataDir(join(root, 'd'))
    setSetting('agent.userLanguage', 'fr')
    setSetting('ui.activeLanguage', 42)
    expect(currentUserLanguage()).toBe('en')
  })
})

describe('fase 17b (A2): noteHumanText', () => {
  it('un testo italiano aggiorna la lingua salvata', async () => {
    const { setDataDir, getSetting, deleteSetting } = await import('../../store/db')
    const { noteHumanText } = await import('../user-language')
    setDataDir(join(root, 'e'))
    deleteSetting('agent.userLanguage')
    noteHumanText('ciao, puoi aiutarmi con questo?')
    expect(getSetting('agent.userLanguage', null)).toBe('it')
  })

  it('un testo inglese cambia la lingua salvata', async () => {
    const { setDataDir, getSetting } = await import('../../store/db')
    const { noteHumanText } = await import('../user-language')
    setDataDir(join(root, 'f'))
    noteHumanText('ciao, puoi aiutarmi con questo?')
    noteHumanText('hello, can you help me with this?')
    expect(getSetting('agent.userLanguage', null)).toBe('en')
  })

  it('con null (testo che non decide) non tocca il setting', async () => {
    const { setDataDir, getSetting, setSetting } = await import('../../store/db')
    const { noteHumanText } = await import('../user-language')
    setDataDir(join(root, 'g'))
    setSetting('agent.userLanguage', 'it')
    noteHumanText('ok')
    noteHumanText('grazie!')
    noteHumanText('npm run build')
    noteHumanText('')
    expect(getSetting('agent.userLanguage', null)).toBe('it')
  })

  it('la stessa lingua non riscrive il setting', async () => {
    const { setDataDir, setSetting } = await import('../../store/db')
    const { noteHumanText } = await import('../user-language')
    setDataDir(join(root, 'h'))
    setSetting('agent.userLanguage', 'it')
    const spy = vi.spyOn(await import('../../store/db'), 'setSetting')
    noteHumanText('puoi farlo tu, per favore?')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

// Fase 17b correzioni (B1): isteresi. Cambiare la lingua globale costa molto,
// quindi un solo messaggio debole nell'altra lingua non basta; ne bastano due
// consecutivi, o uno forte (≥3 colpi).
describe('fase 17b correzioni (B1): isteresi di noteHumanText', () => {
  it('un messaggio forte cambia subito la lingua', async () => {
    const { setDataDir, getSetting, setSetting, deleteSetting } = await import('../../store/db')
    const { noteHumanText } = await import('../user-language')
    setDataDir(join(root, 'i'))
    setSetting('agent.userLanguage', 'it')
    deleteSetting('agent.userLanguageCandidate')
    noteHumanText('hello, can you help me with this?')
    expect(getSetting('agent.userLanguage', null)).toBe('en')
    expect(getSetting('agent.userLanguageCandidate', null)).toBeNull()
  })

  it('due messaggi deboli consecutivi cambiano la lingua', async () => {
    const { setDataDir, getSetting, setSetting, deleteSetting } = await import('../../store/db')
    const { noteHumanText } = await import('../user-language')
    setDataDir(join(root, 'l'))
    setSetting('agent.userLanguage', 'it')
    deleteSetting('agent.userLanguageCandidate')
    // «please send me the file»: 2 colpi EN, debole
    noteHumanText('please send me the file')
    expect(getSetting('agent.userLanguage', null)).toBe('it')
    expect(getSetting('agent.userLanguageCandidate', null)).toBe('en')
    noteHumanText('please send me the file')
    expect(getSetting('agent.userLanguage', null)).toBe('en')
    expect(getSetting('agent.userLanguageCandidate', null)).toBeNull()
  })

  it('debole, poi uno nella lingua salvata, poi debole: nessun cambio', async () => {
    const { setDataDir, getSetting, setSetting, deleteSetting } = await import('../../store/db')
    const { noteHumanText } = await import('../user-language')
    setDataDir(join(root, 'm'))
    setSetting('agent.userLanguage', 'it')
    deleteSetting('agent.userLanguageCandidate')
    noteHumanText('please send me the file')
    noteHumanText('puoi farlo tu, per favore?')
    noteHumanText('please send me the file')
    expect(getSetting('agent.userLanguage', null)).toBe('it')
    // il secondo debole ricomincia da capo: è di nuovo solo un candidato
    expect(getSetting('agent.userLanguageCandidate', null)).toBe('en')
  })

  it('con null il candidato non si tocca', async () => {
    const { setDataDir, getSetting, setSetting, deleteSetting } = await import('../../store/db')
    const { noteHumanText } = await import('../user-language')
    setDataDir(join(root, 'n'))
    setSetting('agent.userLanguage', 'it')
    deleteSetting('agent.userLanguageCandidate')
    noteHumanText('please send me the file')
    expect(getSetting('agent.userLanguageCandidate', null)).toBe('en')
    noteHumanText('ok')
    noteHumanText('')
    noteHumanText('npm run build')
    expect(getSetting('agent.userLanguage', null)).toBe('it')
    expect(getSetting('agent.userLanguageCandidate', null)).toBe('en')
  })

  it('la prima rilevazione si salva anche senza lingua precedente', async () => {
    const { setDataDir, getSetting, deleteSetting } = await import('../../store/db')
    const { noteHumanText } = await import('../user-language')
    setDataDir(join(root, 'o'))
    deleteSetting('agent.userLanguage')
    deleteSetting('agent.userLanguageCandidate')
    // debole, ma è la prima: si salva
    noteHumanText('please send me the file')
    expect(getSetting('agent.userLanguage', null)).toBe('en')
  })
})

describe('fase 17b (A2): il main pubblica ui.activeLanguage', () => {
  it('il payload della chiamata è settings:set con la lingua risolta', async () => {
    const { activeLanguageCall } = await import('../../i18n')
    expect(activeLanguageCall('it')).toEqual({ method: 'settings:set', params: ['ui.activeLanguage', 'it'] })
    expect(activeLanguageCall('en')).toEqual({ method: 'settings:set', params: ['ui.activeLanguage', 'en'] })
  })

  it('publishActiveLanguage chiama il client e ingoia gli errori del daemon', async () => {
    const { publishActiveLanguage } = await import('../../i18n')
    const ok = vi.fn().mockResolvedValue(undefined)
    await publishActiveLanguage('it', ok)
    expect(ok).toHaveBeenCalledWith('settings:set', ['ui.activeLanguage', 'it'])
    const fail = vi.fn().mockRejectedValue(new Error('daemon down'))
    await expect(publishActiveLanguage('en', fail)).resolves.toBeUndefined()
  })
})
