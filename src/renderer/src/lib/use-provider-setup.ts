// G4 (fase guida): la prova della chiave e il salvataggio del provider, in
// UN hook condiviso — estratto dal foglio «Aggiungi provider» delle
// Impostazioni (settings/AddProviderSheet.tsx), che lo usa com'era, e usato
// anche dalla guida del primo avvio. Qui stanno: KIND_LABELS, la regola
// dell'indirizzo effettivo (KNOWN_BASE_URLS), la prova con revisione che
// scarta le risposte vecchie (nextModelProbe) e il salvataggio (saveProvider
// + refresh). La chiave NON si logga mai e NON torna alla UI.
import { useRef, useState } from 'react'
import { api, useStore } from '../store'
import type { ProviderKind } from '../../../shared/types'
import { KNOWN_BASE_URLS, openAiCompatBase } from '../../../main/agent/live-models'
import { hostOfBaseUrl } from '../../../shared/network-host'
import { nextModelProbe, EMPTY_MODEL_PROBE, type ModelProbeState } from './model-probe'
import { CONNECTABLE_KINDS } from './model-select'

/** I nomi dei tipi (i marchi non si traducono). */
export const KIND_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  mistral: 'Mistral',
  zai: 'Z.ai',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  'openai-compatible': 'OpenAI-compatible'
}

/** U6 (fase prima-release): il Nome suggerito per un server compatibile — l'host dell'indirizzo. */
export function suggestedNameOf(baseUrl: string): string {
  return hostOfBaseUrl(baseUrl.trim()) ?? ''
}

/**
 * U6: «Prova» si abilita col SOLO indirizzo quando il tipo lo chiede (i
 * server locali più comuni non hanno chiave); per i tipi a chiave resta la
 * chiave. PURA, con i test.
 */
export function probeButtonDisabled(input: { probing: boolean; apiKey: string; baseUrl: string; needsAddress: boolean }): boolean {
  if (input.probing) return true
  return input.needsAddress ? !input.baseUrl.trim() : !input.apiKey.trim()
}

/** Il gruppo del foglio di collegamento: sul Mac / con chiave / altro server. */
export function providerGroupOf(kind: ProviderKind | string): 'mac' | 'key' | 'server' {
  return CONNECTABLE_KINDS.find((c) => c.kind === kind)?.group ?? 'key'
}

/** L'indirizzo effettivo del tipo: quello scritto, o quello noto del kind. */
export function effectiveBaseUrlOf(kind: ProviderKind | null, baseUrl: string): string {
  return providerGroupOf(kind ?? '') === 'key' ? (baseUrl || (kind ? KNOWN_BASE_URLS[kind] : '') || '') : baseUrl
}

export interface UseProviderSetupOpts {
  /**
   * la prova parte DA SOLA quando cambia la chiave o l'indirizzo, col
   * debounce (è il comportamento del foglio delle Impostazioni; la guida
   * usa il bottone «Prova»)
   */
  autoProbe?: boolean
  /** il debounce della prova automatica (ms, default 400 come il foglio) */
  debounceMs?: number
}

export interface ProviderSetup {
  /** U6: il Nome del provider (precompilato con l'host dell'indirizzo) */
  name: string
  setName(v: string): void
  /** U6: il Nome suggerito dall'indirizzo (cambia finché il campo non è stato ritoccato) */
  suggestedName: string
  apiKey: string
  /** scrive la chiave (e con autoProbe rilancia la prova) */
  setApiKey(v: string): void
  baseUrl: string
  /** scrive l'indirizzo (e con autoProbe rilancia la prova) */
  setBaseUrl(v: string): void
  probe: ModelProbeState
  busy: boolean
  group: 'mac' | 'key' | 'server' | null
  effectiveBaseUrl: string
  /** la prova ADESSO, senza debounce (il bottone «Prova» della guida) */
  probeNow(): void
  /** azzera chiave, indirizzo ed esito (cambio tipo, chiusura) */
  reset(): void
  /**
   * Salva il provider (api.saveProvider: la chiave va nel Portachiavi) e
   * rinfresca l'elenco. Torna l'id del provider, o null senza kind.
   * name.baseUrl.apiKey consentono di salvare valori diversi dal campo.
   */
  save(over?: { name?: string; baseUrl?: string; apiKey?: string }): Promise<string | null>
}

/**
 * Lo stato del collegamento di un provider: chiave, indirizzo, prova e
 * salvataggio. UN solo posto per foglio Impostazioni e guida.
 */
export function useProviderSetup(kind: ProviderKind | null, opts: UseProviderSetupOpts = {}): ProviderSetup {
  const { autoProbe = false, debounceMs = 400 } = opts
  const refreshProviders = useStore((s) => s.refreshProviders)
  const [name, setNameState] = useState('')
  const [apiKey, setApiKeyState] = useState('')
  const [baseUrl, setBaseUrlState] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<ModelProbeState>(EMPTY_MODEL_PROBE)
  const probeRevision = useRef(0)
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const group = kind ? providerGroupOf(kind) : null
  const effectiveBaseUrl = effectiveBaseUrlOf(kind, baseUrl)

  /** La prova con la revisione che scarta le risposte vecchie. */
  const runProbe = (key: string, url: string): void => {
    // U6: la chiave è FACOLTATIVA — basta l'indirizzo (i server locali non la chiedono)
    if (!url.trim()) return
    const revision = ++probeRevision.current
    setProbe((s) => nextModelProbe(s, { type: 'start', revision }, probeRevision.current))
    void api.probeProvider({ kind: kind ?? 'openai-compatible', baseUrl: url.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) })
      .then((r) => setProbe((s) => nextModelProbe(
        s,
        r.ok
          ? { type: 'result', revision, ok: true, models: r.models ?? [] }
          : { type: 'result', revision, ok: false, error: r.error ?? 'error' },
        probeRevision.current
      )))
      .catch(() => setProbe((s) => nextModelProbe(s, { type: 'result', revision, ok: false, error: 'unreachable' }, probeRevision.current)))
  }

  /** La prova programmata (debounce): vale solo l'ultima. */
  const scheduleProbe = (nextKey: string, url: string): void => {
    if (probeTimer.current) clearTimeout(probeTimer.current)
    setProbe(EMPTY_MODEL_PROBE)
    if (!url.trim()) return
    probeTimer.current = setTimeout(() => runProbe(nextKey, url), debounceMs)
  }

  const setApiKey = (v: string): void => {
    setApiKeyState(v)
    if (autoProbe) scheduleProbe(v, effectiveBaseUrl)
    else setProbe(EMPTY_MODEL_PROBE)
  }
  const suggestedName = suggestedNameOf(effectiveBaseUrl)
  const setBaseUrl = (v: string): void => {
    setBaseUrlState(v)
    // U6: il Nome precompilato segue l'indirizzo finché l'utente non l'ha ritoccato
    const nextSuggestion = suggestedNameOf(effectiveBaseUrlOf(kind, v))
    setNameState((cur) => (cur === '' || cur === suggestedName ? nextSuggestion : cur))
    if (autoProbe) scheduleProbe(apiKey, effectiveBaseUrlOf(kind, v))
    else setProbe(EMPTY_MODEL_PROBE)
  }
  const setName = (v: string): void => setNameState(v)
  const probeNow = (): void => runProbe(apiKey, effectiveBaseUrl)
  const reset = (): void => {
    if (probeTimer.current) clearTimeout(probeTimer.current)
    setApiKeyState('')
    setBaseUrlState('')
    setProbe(EMPTY_MODEL_PROBE)
  }

  const save = async (over?: { name?: string; baseUrl?: string; apiKey?: string }): Promise<string | null> => {
    if (!kind) return null
    setBusy(true)
    try {
      const isServer = group === 'server'
      const savedName = over?.name ?? (name.trim() || suggestedName || (isServer ? 'Server' : KIND_LABELS[kind] ?? String(kind)))
      const id = `${isServer ? 'custom' : kind}_${Date.now()}`
      const url = (over?.baseUrl ?? effectiveBaseUrl).trim()
      const key = (over?.apiKey ?? apiKey).trim()
      await api.saveProvider({
        id,
        name: savedName,
        kind: isServer ? 'openai-compatible' : kind,
        baseUrl: url,
        enabled: true,
        ...(key ? { apiKey: key } : {})
      })
      setApiKeyState('')
      setProbe(EMPTY_MODEL_PROBE)
      await refreshProviders()
      return id
    } finally {
      setBusy(false)
    }
  }

  return { name, setName, suggestedName, apiKey, setApiKey, baseUrl, setBaseUrl, probe, busy, group, effectiveBaseUrl, probeNow, reset, save }
}
