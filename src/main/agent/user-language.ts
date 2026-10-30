// Fase 17b (A2): la lingua dell'utente è una proprietà GLOBALE dell'installazione
// (Homun ha un solo utente): tutti i bot, i sottoagenti e i gruppi la ricevono
// dal codice, così una delega non può perderla. Due setting nello stesso store
// di getSetting/setSetting:
// - 'agent.userLanguage': l'ultima lingua RILEVATA in un messaggio scritto da
//   una persona (noteHumanText);
// - 'ui.activeLanguage': la lingua RISOLTA dell'app, scritta dal main.
// Il ripiego è 'en', coerente con resolveUiLanguage dell'interfaccia.
import { detectLanguageDetail, type Lang } from '../../shared/language'
import { getSetting, setSetting, deleteSetting } from '../store/db'

const USER_LANGUAGE_KEY = 'agent.userLanguage'
const ACTIVE_LANGUAGE_KEY = 'ui.activeLanguage'
// Fase 17b correzioni (B1): candidato dell'isteresi. Cambiare la lingua globale
// costa molto (tocca tutti i bot e le deleghe): un singolo messaggio debole
// nell'altra lingua non basta.
const CANDIDATE_KEY = 'agent.userLanguageCandidate'

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
 *
 * Isteresi (fase 17b correzioni, B1): senza lingua salvata la prima rilevazione
 * si salva. Con una lingua già salvata, una rilevazione diversa la cambia solo
 * se il testo è FORTE (≥3 colpi della lingua vincente) oppure se anche la
 * rilevazione umana precedente dava la stessa lingua nuova (candidato). Una
 * rilevazione uguale alla lingua salvata azzera il candidato. Il singolo
 * messaggio nell'altra lingua resta coperto dal prompt: la sezione Language
 * dice di rispondere nella lingua dell'ultimo messaggio.
 */
export function noteHumanText(text: string): void {
  const det = detectLanguageDetail(text)
  if (det === null) return
  const saved = getSetting<unknown>(USER_LANGUAGE_KEY, null)
  if (!validLang(saved)) {
    setSetting(USER_LANGUAGE_KEY, det.lang)
    return
  }
  if (saved === det.lang) {
    if (getSetting<unknown>(CANDIDATE_KEY, null) !== null) deleteSetting(CANDIDATE_KEY)
    return
  }
  const candidate = getSetting<unknown>(CANDIDATE_KEY, null)
  if (det.hits >= 3 || candidate === det.lang) {
    setSetting(USER_LANGUAGE_KEY, det.lang)
    deleteSetting(CANDIDATE_KEY)
  } else {
    setSetting(CANDIDATE_KEY, det.lang)
  }
}
