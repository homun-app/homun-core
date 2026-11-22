// A4 (fase centro-autorizzazioni): la notifica di sistema delle richieste
// che spettano all'utente — «<Bot> chiede a te: <frase breve>», il click
// apre il centro SU quella richiesta. Meccanismo del main già presente
// (17a/17c: decideNotification + HostBridge.notify), niente librerie nuove.
// Qui vive solo il RAGGRUPPAMENTO (puro, tempo iniettato): al massimo UNA
// notifica ogni 30 s; se nel frattempo nascono altre richieste, la
// notifica successiva dice «N richieste aspettano te». La finestra a fuoco
// sopprime tutto (l'app ci pensa da sé: riquadro e barra).
import { uiLanguage, formatUi, ui } from '../main/ui-language'
import { UI } from '../shared/ui-messages'
// A3 (fase approvazioni-chiare): la categoria della card, per la frase chiusa
import { squadApprovalCategory } from '../main/agent/squad-approvals'
import type { SquadPendingApprovalInfo } from '../shared/types'
import type { UiMessageDescriptor } from '../shared/ui-text'

/** la finestra del raggruppamento: al massimo una notifica ogni 30 s */
export const APPROVAL_NOTIFY_WINDOW_MS = 30_000

export interface ApprovalNotifierDeps {
  /** la consegna vera (HostBridge: notifica nativa con la UI, osascript senza) */
  notify(title: string, body: string, openApprovalsFor: string): void
  /** la finestra dell'app è in primo piano? (ricontrollata anche alla scadenza) */
  windowFocused(): boolean
  now(): number
  /** la lingua dei testi (come notifyTexts: la lingua dell'interfaccia di default) */
  lang?: 'it' | 'en'
}

export type ApprovalBornInput = {
  /** l'impostazione delle notifiche di oggi (notifications.disabledAgents) */
  enabled: boolean
  /** il bot MOSTRATO (il padre, per le richieste di un sottoagente) */
  agentName: string
  /** la frase breve della card (l'anteprima di needs-input) */
  phrase: string
  approvalId: string
}

/**
 * Il raggruppatore: una istanza per il daemon. La prima richiesta di una
 * finestra ha la sua notifica singola; le altre nate nei 30 s contano e, a
 * finestra scaduta, una SOLA aggregata le riassume («N richieste aspettano
 * te», il click apre il centro in generale). La finestra torna a fuoco →
 * l'aggregata in sospeso non si consegna più.
 */
export function createApprovalNotifier(deps: ApprovalNotifierDeps) {
  const lang = deps.lang
  let lastDeliveredAt: number | null = null
  /** quante richieste sono nate dall'ultima consegna (la prima compresa) */
  let born = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const deliver = (title: string, body: string, openApprovalsFor: string): void => {
    lastDeliveredAt = deps.now()
    deps.notify(title, body, openApprovalsFor)
  }

  const fire = (): void => {
    timer = null
    // l'utente ha appena riaperto l'app: niente notifica in ritardo
    if (deps.windowFocused()) {
      born = 0
      return
    }
    if (born > 1) {
      deliver(formatUi(ui(UI.approvalNotifyAggregated, { count: born }), lang ?? uiLanguage()), '', 'all')
    }
    born = 0
  }

  return {
    /** una richiesta è nata (evento approval/needs-input con approvalId) */
    onApprovalBorn(input: ApprovalBornInput): void {
      if (!input.enabled) return
      if (deps.windowFocused()) return
      const now = deps.now()
      if (lastDeliveredAt === null || now - lastDeliveredAt >= APPROVAL_NOTIFY_WINDOW_MS) {
        born = 1
        // «<Bot> chiede a te: <frase breve>» — il click apre il centro su di lei
        deliver(formatUi(ui(UI.approvalNotifySingle, { agent: input.agentName }), lang ?? uiLanguage()), input.phrase.slice(0, 120), input.approvalId)
        return
      }
      // nel gruppo: conta, e la finestra si chiude 30 s dalla PRIMA consegna
      born++
      if (timer === null) {
        const ms = Math.max(0, lastDeliveredAt + APPROVAL_NOTIFY_WINDOW_MS - now)
        timer = setTimeout(fire, ms)
      }
    },

    /** per i test e la pulizia: il timer in sospeso */
    hasPendingTimer(): boolean {
      return timer !== null
    }
  }
}

export type ApprovalNotifier = ReturnType<typeof createApprovalNotifier>

/**
 * A3 (fase approvazioni-chiare): il corpo RIPULITO della notifica di una
 * richiesta — come X2 per i server MCP, una delle frasi dell'ELENCO CHIUSO
 * del catalogo UI per categoria (notify.approvalBody*), MAI il testo libero
 * della card (niente URL di siti, nomi di server, destinatari o comandi: il
 * titolo dice già il bot, il clic porta all'app). PURA.
 */
export function approvalNotifyBodyOf(
  lang: 'it' | 'en',
  entry: { kind: string; content?: string; meta?: Record<string, unknown> | null }
): string {
  const category = squadApprovalCategory(entry)
  const m: Record<SquadPendingApprovalInfo['category'], UiMessageDescriptor> = {
    'dati-tuoi': UI.approvalNotifyBodyData,
    pagamento: UI.approvalNotifyBodyPayment,
    invio: UI.approvalNotifyBodyOutgoing,
    'sito-interattivo': UI.approvalNotifyBodySite,
    mac: UI.approvalNotifyBodyMac,
    squadra: UI.approvalNotifyBodyTeam,
    altro: UI.approvalNotifyBodyOther
  }
  return formatUi(ui(m[category]), lang)
}
