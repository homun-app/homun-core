// OB1 (fase onboarding-b): i FATTI VERIFICATI della release 1.7.1 di Apple
// `container`, letti dall'API di GitHub e fissati QUI, in un solo modulo.
// Sono costanti: si aggiornano SOLO con una fase apposita, MAI leggendo
// «latest» a runtime (il permalink punta alla versione). Un test le blocca
// una per una (apple-container-release.test.ts).
//
// Release 1.7.1, pubblicata il 2026-11-06:
//   file      container-1.7.1-installer-signed.pkg
//   URL       https://github.com/apple/container/releases/download/1.7.1/container-1.7.1-installer-signed.pkg
//   dimensione 169 630 704 byte
//   sha256    b6739caf3d47ca53a78f1a7edf32521420a75c7941838c3cefa75f30b80f5a97

/** La versione del pacchetto firmato che la preparazione scarica e installa. */
export const APPLE_CONTAINER_VERSION = '1.7.1'

/** Il nome del file del pacchetto firmato. */
export const APPLE_CONTAINER_PKG_FILE = 'container-1.7.1-installer-signed.pkg'

/** Il permalink del download (mai «latest»: la versione sta nell'URL). */
export const APPLE_CONTAINER_PKG_URL =
  'https://github.com/apple/container/releases/download/1.7.1/container-1.7.1-installer-signed.pkg'

/** La dimensione esatta del pacchetto, al byte. */
export const APPLE_CONTAINER_PKG_BYTES = 169_630_704

/** Lo sha256 esatto del pacchetto (la verifica lo confronta con questo). */
export const APPLE_CONTAINER_PKG_SHA256 =
  'b6739caf3d47ca53a78f1a7edf32521420a75c7941838c3cefa75f30b80f5a97'
