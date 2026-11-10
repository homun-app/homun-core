// Fase rilascio di prova (RP3): il canale degli aggiornamenti come valore
// PURO condiviso (renderer lo scrive, main lo applica): 'stable' (default) o
// 'beta'. Una versione DI PROVA in esecuzione (app.getVersion() con -beta.)
// tiene allowPrerelease = true anche col canale stabile: chi prova continua
// a ricevere le prove fino alla stabile, che per semver è più nuova.
import { describe, expect, it } from 'vitest'
import { UPDATE_CHANNEL_SETTING, allowPrereleaseFor, isBetaVersion, parseUpdateChannel } from '../update-channel'

describe('fase rilascio di prova (RP3): updates.channel', () => {
  it('il setting si chiama updates.channel', () => {
    expect(UPDATE_CHANNEL_SETTING).toBe('updates.channel')
  })

  it('parseUpdateChannel: solo «beta» è beta, tutto il resto (anche spazzatura) è stable', () => {
    expect(parseUpdateChannel('beta')).toBe('beta')
    expect(parseUpdateChannel('stable')).toBe('stable')
    expect(parseUpdateChannel(undefined)).toBe('stable')
    expect(parseUpdateChannel('BETA')).toBe('stable')
    expect(parseUpdateChannel({ malevolo: true })).toBe('stable')
  })

  it('isBetaVersion: una versione con -beta. è una versione di prova', () => {
    expect(isBetaVersion('0.3.1001-beta.1')).toBe(true)
    expect(isBetaVersion('0.3.1001-beta.12')).toBe(true)
    expect(isBetaVersion('0.3.1001')).toBe(false)
    expect(isBetaVersion('0.3.1001-alpha.1')).toBe(false)
  })

  it('allowPrereleaseFor: canale beta → true; stabile → false; MA una beta in esecuzione → true sempre', () => {
    expect(allowPrereleaseFor('beta', '0.3.1001')).toBe(true)
    expect(allowPrereleaseFor('stable', '0.3.1001')).toBe(false)
    // chi prova continua a ricevere le prove finché non arriva la stabile
    expect(allowPrereleaseFor('stable', '0.3.1001-beta.1')).toBe(true)
    expect(allowPrereleaseFor('beta', '0.3.1001-beta.2')).toBe(true)
  })
})
