// OB1 (fase onboarding-b): le costanti della release 1.7.1 di Apple
// `container` — URL, dimensione e sha256 VERIFICATI dall'API di GitHub e
// fissati qui dentro (la spec li dà per buoni: NON si cambiano e NON si
// legge mai «latest» a runtime). Il test li blocca uno per uno: chi tocca
// un numero senza una fase apposita rompe questo file.
import { describe, expect, it } from 'vitest'
import {
  APPLE_CONTAINER_VERSION,
  APPLE_CONTAINER_PKG_FILE,
  APPLE_CONTAINER_PKG_URL,
  APPLE_CONTAINER_PKG_BYTES,
  APPLE_CONTAINER_PKG_SHA256,
  APPLE_CONTAINER_TEAM_ID,
  APPLE_CONTAINER_LEAF_CERT
} from '../apple-container-release'

describe('OB1: le costanti della release di Apple container (bloccate)', () => {
  it('la versione è 1.7.1', () => {
    expect(APPLE_CONTAINER_VERSION).toBe('1.7.1')
  })

  it('il file è il pacchetto firmato di quella versione', () => {
    expect(APPLE_CONTAINER_PKG_FILE).toBe('container-1.7.1-installer-signed.pkg')
  })

  it("l'URL è il download della release 1.7.1 su github.com/apple/container", () => {
    expect(APPLE_CONTAINER_PKG_URL).toBe('https://github.com/apple/container/releases/download/1.7.1/container-1.7.1-installer-signed.pkg')
    // MAI «latest»: il permalink punta alla versione
    expect(APPLE_CONTAINER_PKG_URL).not.toContain('latest')
  })

  it('la dimensione è quella verificata, al byte', () => {
    expect(APPLE_CONTAINER_PKG_BYTES).toBe(169_630_704)
  })

  it('lo sha256 è quello verificato', () => {
    expect(APPLE_CONTAINER_PKG_SHA256).toBe('b6739caf3d47ca53a78f1a7edf32521420a75c7941838c3cefa75f30b80f5a97')
  })

  it('lo sha256 è un esadecimale di 64 caratteri (nessun numero inventato)', () => {
    expect(APPLE_CONTAINER_PKG_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('OBV6: il firmatario VERO visto dalla prova dal vivo (bloccato)', () => {
  it('il Team ID della strada Developer ID notarizzata', () => {
    expect(APPLE_CONTAINER_TEAM_ID).toBe('UPBK2H6LZM')
  })

  it('la FOGLIA attesa: Developer ID Installer di Apple per Containerization', () => {
    expect(APPLE_CONTAINER_LEAF_CERT).toBe('Developer ID Installer: Apple Inc. - Containerization (UPBK2H6LZM)')
  })
})
