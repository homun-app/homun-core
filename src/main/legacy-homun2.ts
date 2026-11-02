// Fase rilascio (A8): il passaggio da Homun 2. Se esiste la cartella dati di
// Homun 2 (~/Library/Application Support/Homun2, o ~/…/Homun con engine),
// al primo avvio compare UNA VOLTA una riga che informa l'utente. NON si
// legge e NON si tocca niente dentro quelle cartelle: si controlla solo che
// esistano (existsSync, il nome della sottocartella engine è il minimo per
// non confondere Homun 2 con l'eventuale …/Homun di altri). Funzioni PURE:
// la sonda del filesystem si inietta.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** True se la cartella è la sede dati di Homun 2 (con la cartella engine). */
export function isLegacyHomun2DataDir(appData: string, name: 'Homun2' | 'Homun', exists: (p: string) => boolean): boolean {
  return exists(join(appData, name, 'engine'))
}

/**
 * La cartella di Homun 2 da indicare all'utente, se c'è: Homun2 vince su
// Homun (il percorso storico di Homun 2 è Homun2). Null se non c'è nessuna.
 */
export function findLegacyHomun2Dir(appData: string, exists: (p: string) => boolean = existsSync): string | null {
  if (isLegacyHomun2DataDir(appData, 'Homun2', exists)) return join(appData, 'Homun2')
  if (isLegacyHomun2DataDir(appData, 'Homun', exists)) return join(appData, 'Homun')
  return null
}

/** Il marker «la riga del rinnovo è già stata mostrata» sta nell'userData. */
export function legacyNoticeMarkerPath(userData: string): string {
  return join(userData, 'legacy-homun2-noticed')
}
