// Fase rilascio di prova (RP3): il canale degli aggiornamenti. Valore PURO
// condiviso — il renderer lo mostra e lo scrive (Impostazioni › Generali,
// «Ricevi le versioni di prova»), il main lo applica a electron-updater
// (allowPrerelease) al primo controllo, a ogni «Controlla aggiornamenti» e
// quando l'interruttore cambia: mai un riavvio richiesto.
//
// Le versioni 0.3.1001-beta.N escono come PRERELEASE di GitHub: chi ha il
// canale stabile (electron-updater con allowPrerelease = false, il default —
// è così anche per Homun 2) non le vede proprio; le vede solo chi accende il
// canale di prova. Chi ha una beta in esecuzione continua a riceverle finché
// non arriva la stabile, che per semver è più nuova.
export type UpdateChannel = 'stable' | 'beta'

/** Il setting del canale, nel store delle impostazioni (settings:get/set). */
export const UPDATE_CHANNEL_SETTING = 'updates.channel'

/** 'beta' solo se il valore è ESATTAMENTE 'beta': tutto il resto è stabile. */
export function parseUpdateChannel(value: unknown): UpdateChannel {
  return value === 'beta' ? 'beta' : 'stable'
}

/** Una versione DI PROVA in esecuzione (0.3.1001-beta.N)? */
export function isBetaVersion(version: string): boolean {
  return version.includes('-beta.')
}

/**
 * La politica del prerelease: il canale di prova lo accende; e una beta in
 * esecuzione lo tiene ACCESO anche col canale stabile (chi prova continua a
 * ricevere le prove fino alla stabile, che per semver è più nuova).
 */
export function allowPrereleaseFor(channel: UpdateChannel, runningVersion: string): boolean {
  return channel === 'beta' || isBetaVersion(runningVersion)
}
