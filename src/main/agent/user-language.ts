// Fase 17b (A2): la lingua dell'utente è una proprietà GLOBALE dell'installazione
// (Homun ha un solo utente): tutti i bot, i sottoagenti e i gruppi la ricevono
// dal codice, così una delega non può perderla. Due setting nello stesso store
// di getSetting/setSetting:
// - 'agent.userLanguage': l'ultima lingua RILEVATA in un messaggio scritto da
//   una persona (noteHumanText);
// - 'ui.activeLanguage': la lingua RISOLTA dell'app, scritta dal main.
// Il ripiego è 'en', coerente con resolveUiLanguage dell'interfaccia.
import { detectLanguage, type Lang } from '../../shared/language'
import { getSetting, setSetting } from '../store/db'

const USER_LANGUAGE_KEY = 'agent.userLanguage'
const ACTIVE_LANGUAGE_KEY = 'ui.activeLanguage'

function validLang(v: unknown): v is Lang {
  return v === 'it' || v === 'en'
}

/**
 * La lingua in cui l'agente scrive all'utente: l'ultima rilevata da un
 * messaggio umano se valida, altrimenti la lingua risolta dell'app,
 * altrimenti 'en'.
 */
export function currentUserLanguage(): Lang {
  const detected = getSetting<unknown>(USER_LANGUAGE_KEY, null)
  if (validLang(detected)) return detected
  const active = getSetting<unknown>(ACTIVE_LANGUAGE_KEY, null)
  if (validLang(active)) return active
  return 'en'
}

/**
 * Registra il testo scritto da una persona: se detectLanguage decide una
 * lingua diversa da quella salvata, la aggiorna. Con null non tocca nulla
 * («ok», un URL, un comando non cambiano la lingua). Si chiama SOLO dove
 * entra testo umano: mai su messaggi di sistema, bot, tool o contenuti esterni.
 */
export function noteHumanText(text: string): void {
  const lang = detectLanguage(text)
  if (lang === null) return
  if (getSetting<unknown>(USER_LANGUAGE_KEY, null) === lang) return
  setSetting(USER_LANGUAGE_KEY, lang)
}
