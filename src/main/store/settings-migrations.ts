// Fase impostazioni (I3/I4/I8): le migrazioni dei SETTING che rendono visibile
// ciò che il motore faceva in silenzio. Tutte UNA TANTUM con FLAG (idempotenti:
// al secondo giro il flag scatta e non si tocca niente), girano al primo avvio
// del daemon (runtime.ts) e hanno un test su una fixture coi setting della
// 0.3.1000/0.3.1001.
//
//   I3.1  models.fallbackMaterialized — la riserva effettiva del provider
//         principale (override utente in providers.modelDefaults oppure il
//         default del kind) diventa la PRIMA voce di models.fallbackChain.
//         Così chi oggi ha la riserva implicita la VEDE nella pagina e non
//         perde niente; il motore (routeChain) non la inserisce più da solo.
//   I3.2  autoReview.materialized — il ripiego silenzioso del revisore
//         (autoReviewModelFor del primo provider attivo) si scrive in
//         autoReview.providerId/model, se il revisore non è scelto.
//   I4.1  approvals.modeSet — il modo nasce da autoReview.enabled:
//         true → 'auto', altrimenti 'ask' (mai 'never' per migrazione).
//   MB2   sandbox.mode (fase modalita-box) — chi ha installato la beta.5
//         aveva la guida arrivata in fondo (box.setup ready, o una fase in
//         corsa) ma NESSUN codice scriveva sandbox.mode: il computer del
//         bot era pronto e i comandi giravano sul Mac. La migrazione
//         registra 'box' SOLO se la riga manca, l'utente non ha scelto
//         (sandbox.modeSet) e la preparazione è ready o in corsa. La riga
//         scritta È il flag: alla seconda corsa la condizione non scatta più.
//
// Il core è PURO (dict in/dict out, testato senza database); il runner legge e
// scrive i setting veri. providers.modelDefaults NON si cancella: resta per
// compatibilità, ma l'interfaccia non lo scrive più.
import type { ApprovalsMode, AutoReviewSettings, FallbackRoute, MainModel, ProviderConfig } from '../../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../../shared/types'
import { fallbackModelFor, autoReviewModelFor, type ModelDefaultsMap } from '../agent/model-defaults'
// MB2 (fase modalita-box): la fase della preparazione CORRE? La stessa
// domanda che fa la sandbox all'uso del box (OB4)
import { boxSetupRunningOf } from '../sandbox'
import { getSetting, setSetting } from './db'

/** Il setting che contiene la lista dei provider (senza chiavi: qui bastano i metadati). */
type ProviderLike = Pick<ProviderConfig, 'id' | 'kind' | 'enabled'>

/** Le dipendenze del core puro: tutto ciò che serve, iniettabile nei test. */
export interface MigrationInput {
  main: MainModel | null
  chain: FallbackRoute[]
  providers: ProviderLike[]
  modelDefaults: ModelDefaultsMap
  autoReview: AutoReviewSettings
  approvalsMode: ApprovalsMode | undefined
  /**
   * MB2 (fase modalita-box): la riga sandbox.mode COM'È oggi (undefined =
   * manca). Qualunque valore presente — anche lo storico 'docker' — è una
   * scelta già fatta che la migrazione non tocca.
   */
  sandboxMode: string | undefined
  /** MB2: l'utente ha scelto esplicitamente dalla guida o dalle Impostazioni. */
  sandboxModeSet: boolean
  /** MB2: la fase di box.setup COM'È oggi (null = il setting manca). */
  boxSetupPhase: string | null
  /** i flag già scritti (il runner passa i setting veri) */
  flags: { fallbackMaterialized?: boolean; reviewerMaterialized?: boolean; modeSet?: boolean }
}

/** Il risultato: i setting DA SCRIVERE (solo quelli cambiati) e i flag. */
export interface MigrationResult {
  chain?: FallbackRoute[]
  autoReview?: AutoReviewSettings
  approvalsMode?: ApprovalsMode
  /** MB2: la modalità del computer del bot da registrare ('box' o niente). */
  sandboxMode?: 'box'
  flags: { fallbackMaterialized: boolean; reviewerMaterialized: boolean; modeSet: boolean }
}

/**
 * I3.1 (puro): la riserva effettiva del provider principale — l'override
 * utente o il default del kind — diventa la prima voce della catena, SOLO se:
 * models.main c'è, la catena è VUOTA e la riserva è diversa dal principale.
 * Con la catena già piena non si tocca niente (l'utente ha già scelto).
 */
export function materializeFallbackChain(input: MigrationInput): FallbackRoute[] | undefined {
  if (input.flags.fallbackMaterialized) return undefined
  const main = input.main
  if (!main || !main.providerId || !main.model) return undefined
  if (input.chain.length > 0) return undefined
  const provider = input.providers.find((p) => p.id === main.providerId)
  if (!provider) return undefined
  const fb = fallbackModelFor(provider, input.modelDefaults)
  if (!fb || fb === main.model) return undefined
  return [{ providerId: provider.id, model: fb }]
}

/**
 * I3.2 (puro): il ripiego del revisore di oggi (autoReviewModelFor: del
 * provider scelto, se ce l'ha; altrimenti del primo attivo che ce l'ha) si
 * scrive in autoReview, se il revisore non è scelto. Restano al loro posto
 * regole ed enabled.
 */
export function materializeReviewer(input: MigrationInput): AutoReviewSettings | undefined {
  if (input.flags.reviewerMaterialized) return undefined
  if (input.autoReview.providerId && input.autoReview.model) return undefined
  const overrides = input.modelDefaults
  let provider: ProviderLike | undefined
  if (input.autoReview.providerId) {
    provider = input.providers.find((p) => p.id === input.autoReview.providerId && p.enabled)
  } else {
    provider = input.providers.find((p) => p.enabled && autoReviewModelFor(p, overrides))
  }
  if (!provider) return undefined
  const model = input.autoReview.model ?? autoReviewModelFor(provider, overrides)
  if (!model) return undefined
  return { ...input.autoReview, providerId: provider.id, model }
}

/**
 * I4.1 (puro): approvals.mode nasce da autoReview.enabled. La migrazione non
 * scrive MAI 'never': è una scelta che spetta solo all'utente, con la sua
 * conferma.
 */
export function materializeApprovalsMode(input: MigrationInput): ApprovalsMode | undefined {
  if (input.flags.modeSet) return undefined
  if (input.approvalsMode === 'ask' || input.approvalsMode === 'auto' || input.approvalsMode === 'never') return undefined
  return input.autoReview.enabled ? 'auto' : 'ask'
}

/**
 * MB2 (fase modalita-box, puro): chi ha installato la beta.5 ha la guida
 * arrivata in fondo (box.setup ready, o una fase ancora in corsa) e NESSUNA
 * riga sandbox.mode — la preparazione c'è, la scelta non era mai stata
 * registrata e i comandi giravano sul Mac. La migrazione la registra:
 * 'box' SOLO se la riga manca, l'utente non ha scelto esplicitamente
 * (sandbox.modeSet) e la preparazione è ready o sta correndo. La riga scritta
 * È l'idempotenza: alla seconda corsa sandboxMode è presente e non scatta
 * più (non serve un flag in più: la condizione di ingresso è il flag).
 */
export function materializeSandboxMode(input: MigrationInput): 'box' | undefined {
  if (input.sandboxMode !== undefined) return undefined // già scelta (anche 'docker' storico)
  if (input.sandboxModeSet) return undefined // scelta esplicita: mai ribaltata
  if (input.boxSetupPhase === null) return undefined // box.setup manca: chi non ha preparato resta sul Mac
  return boxSetupRunningOf(input.boxSetupPhase) || input.boxSetupPhase === 'ready' ? 'box' : undefined
}

/** Il core puro delle quattro migrazioni (I3.1 + I3.2 + I4.1 + MB2). */
export function runSettingsMigrations(input: MigrationInput): MigrationResult {
  const chain = materializeFallbackChain(input)
  const autoReview = materializeReviewer(input)
  const approvalsMode = materializeApprovalsMode(input)
  const sandboxMode = materializeSandboxMode(input)
  return {
    ...(chain !== undefined ? { chain } : {}),
    ...(autoReview !== undefined ? { autoReview } : {}),
    ...(approvalsMode !== undefined ? { approvalsMode } : {}),
    ...(sandboxMode !== undefined ? { sandboxMode } : {}),
    // i flag si scrivono SEMPRE al primo giro (anche quando non c'è niente da
    // materializzare): è questo che rende la migrazione una tantum
    flags: {
      fallbackMaterialized: true,
      reviewerMaterialized: true,
      modeSet: true
    }
  }
}

// ---- il runner sui setting veri (daemon) ----

/**
 * Fase impostazioni (I8): gira al primo avvio del daemon, idempotente. Ogni
 * esito va nel log del daemon (una riga, niente dati dell'utente).
 */
export function migrateImpostazioniSettings(): void {
  const input: MigrationInput = {
    main: getSetting<MainModel | null>('models.main', null),
    chain: getSetting<FallbackRoute[]>('models.fallbackChain', []),
    providers: getSetting<Array<ProviderLike & { apiKey?: unknown }>>('providers', [])
      .map((p) => ({ id: p.id, kind: p.kind, enabled: p.enabled })),
    modelDefaults: getSetting<ModelDefaultsMap>('providers.modelDefaults', {}),
    autoReview: { ...DEFAULT_AUTO_REVIEW, ...getSetting<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW) },
    approvalsMode: getSetting<ApprovalsMode | undefined>('approvals.mode', undefined),
    // MB2 (fase modalita-box): i fatti della scelta — riga, scelta esplicita,
    // fase della preparazione (null se box.setup manca)
    sandboxMode: getSetting<string | undefined>('sandbox.mode', undefined),
    sandboxModeSet: getSetting<boolean>('sandbox.modeSet', false),
    boxSetupPhase: getSetting<{ phase?: string } | null>('box.setup', null)?.phase ?? null,
    flags: {
      fallbackMaterialized: getSetting<boolean>('models.fallbackMaterialized', false) || undefined,
      reviewerMaterialized: getSetting<boolean>('autoReview.materialized', false) || undefined,
      modeSet: getSetting<boolean>('approvals.modeSet', false) || undefined
    }
  }
  const result = runSettingsMigrations(input)
  if (result.chain !== undefined) setSetting('models.fallbackChain', result.chain)
  if (result.autoReview !== undefined) setSetting('autoReview', result.autoReview)
  if (result.approvalsMode !== undefined) setSetting('approvals.mode', result.approvalsMode)
  if (result.sandboxMode !== undefined) setSetting('sandbox.mode', result.sandboxMode)
  setSetting('models.fallbackMaterialized', result.flags.fallbackMaterialized)
  setSetting('autoReview.materialized', result.flags.reviewerMaterialized)
  setSetting('approvals.modeSet', result.flags.modeSet)
  const done: string[] = []
  if (result.chain !== undefined) done.push(`riserva materializzata (${result.chain.length} voce/i)`)
  if (result.autoReview !== undefined) done.push('revisore materializzato')
  if (result.approvalsMode !== undefined) done.push(`approvals.mode = ${result.approvalsMode}`)
  if (result.sandboxMode !== undefined) done.push(`modalità del computer del bot = ${result.sandboxMode}`)
  if (done.length) console.log(`[sandbotd] migrazione impostazioni: ${done.join(' · ')}`)
}
