// Fase impostazioni (I2.3): il foglio «Aggiungi provider» — un elenco CON
// RICERCA dei tipi (Sul tuo Mac · Con una chiave · Un altro server) e poi i
// campi di sempre di AddModelRail per il tipo scelto (prova automatica della
// chiave, «Collega <tipo>»). È lo stesso foglio che «Collega» apre dentro
// ModelSelect (I1.2), già sul tipo giusto: per questo vive qui, condiviso.
// G4 (fase guida): la prova della chiave e il salvataggio stanno nell'hook
// condiviso useProviderSetup (lib/use-provider-setup.ts) — lo usa anche la
// guida del primo avvio; per l'utente questo foglio non cambia.
//
// Fase design (DS4, Impostazioni): il foglio passa al sistema. La scheda ha
// il raggio delle superfici (prima 24 px), il titolo è text-title (i titoli di
// dialoghi e schede di DS1: prima 18 px in Bricolage, il font che resta solo
// al titolo di pagina); l'elenco dei tipi e quello dei provider trovati sono
// righe a filo (FlatRow: prima ogni tipo una riga scritta a mano dentro una
// scheda), con le etichette di gruppo del sistema; la ricerca è una pillola
// alta 36 col campo dentro; i campi sono Input da 36 (prima 40 e 30, con
// l'iniziale a 12 px) e le azioni Button (l'indietro un bottone tondo da 32).
// I loghi (ProviderMark) sono quelli di DS1: 40 nelle testate, 32 nelle righe
// — lo usa anche ModelSelect, che li troverà già alla misura del sistema.
// Testi, placeholder e l'id del campo chiave non cambiano: li cercano i test
// e le sonde.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { ChevronLeft, Server } from 'lucide-react'
import { api } from '../../store'
import type { ProviderKind, ProviderPublic } from '../../../../shared/types'
import { providerLogoUrl, providerLogoSvg } from '../../lib/provider-logos'
import { suggestedNameOf } from '../../lib/use-provider-setup'
import { CONNECTABLE_KINDS } from '../../lib/model-select'
// i nomi dei tipi e la logica di prova/salvataggio: hook condiviso (G4), usato
// anche dalla guida del primo avvio
import { KIND_LABELS, useProviderSetup } from '../../lib/use-provider-setup'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { SearchField } from '../ui/search-field'
import { FlatList, FlatRow } from '../ui/flat-list'
import { Input } from '../ui/input'
import { FIELD_PAGE_CLS, FOCUS_RING } from './SettingsRow'

export { KIND_LABELS }

const GROUP_LABELS: Record<'mac' | 'key' | 'server', MessageDescriptor> = {
  mac: msg`Sul tuo Mac`,
  key: msg`Con una chiave`,
  server: msg`Un altro server`
}

/**
 * DS1: i loghi delle app sono 40 px nelle testate di scheda e 32 px nelle
 * righe (prima 44 e 28). Il raggio segue la misura — quello delle superfici
 * sul 40, quello dei controlli sul 32 — e l'iniziale (per i tipi senza logo)
 * è la metà della piastrella.
 */
const MISURA = {
  md: 'size-10 rounded-surface text-title',
  sm: 'size-8 rounded-control text-reading'
} as const

/** Un link-bottone dentro una riga del foglio («Avanzate», «Fatto»): grigio, in primo piano al passaggio. */
const LINK_BOTTONE = cn('rounded-control px-1.5 py-1 text-small text-muted-foreground transition hover:text-foreground', FOCUS_RING)

/**
 * La piastrella del tipo: il logo vero se c'è, l'iniziale altrimenti (I2.4).
 *  U5 (fase prima-release): i loghi MONOCROMI (Anthropic, OpenAI — Simple
 *  Icons, CC0) si rendono INLINE col colore del testo, SENZA piastrella:
 *  dentro un <img> un SVG non eredita currentColor. Un solo componente per
 *  tutti i loghi: guida, Impostazioni › Modelli, foglio, scelta del modello.
 */
export function ProviderMark({ kind, name, size = 'md' }: { kind: ProviderKind | string; name: string; size?: 'sm' | 'md' }) {
  const url = providerLogoUrl(kind as ProviderKind)
  const dim = MISURA[size]
  const mono = providerLogoSvg(kind as ProviderKind)
  // U6: il compatibile e il custom non sono un'azienda: icona GENERICA Server, monocroma.
  // La misura dell'icona è scritta FISSA in ciascun ramo (la guarda la guardia: un'espressione no)
  if (kind === 'openai-compatible' || kind === 'custom') {
    return (
      <span className={cn(dim, 'grid shrink-0 place-items-center bg-card text-foreground')} title={name}>
        {size === 'md' ? <Server className="size-5" aria-hidden="true" /> : <Server className="size-4" aria-hidden="true" />}
      </span>
    )
  }
  if (mono) {
    return (
      <span
        className={cn(dim, 'grid shrink-0 place-items-center text-foreground [&>svg]:size-3/4')}
        title={name}
        dangerouslySetInnerHTML={{ __html: mono }}
      />
    )
  }
  if (url) {
    return (
      <span className={cn(dim, 'grid shrink-0 place-items-center overflow-hidden bg-card dark:bg-white')} title={name}>
        <img src={url} alt="" className="size-3/4 object-contain" draggable={false} />
      </span>
    )
  }
  return (
    <span className={cn(dim, 'grid shrink-0 place-items-center bg-card font-semibold')}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

export interface AddProviderSheetProps {
  /** il tipo già scelto (da «Collega» nel ModelSelect): salta l'elenco */
  initialKind?: ProviderKind | null
  onClose(): void
  /** collegamento riuscito: l'id del provider appena salvato */
  onSaved(providerId: string): void
}

export function AddProviderSheet({ initialKind, onClose, onSaved }: AddProviderSheetProps) {
  const { t, i18n } = useLingui()
  const [kind, setKind] = useState<ProviderKind | null>(initialKind ?? null)
  const [query, setQuery] = useState('')
  // — sul Mac —
  const [scanning, setScanning] = useState(false)
  const [found, setFound] = useState<ProviderPublic[] | null>(null)
  const [scanError, setScanError] = useState(false)
  // — chiave / altro server: la prova e il salvataggio stanno nell'hook condiviso —
  const setup = useProviderSetup(kind, { autoProbe: true })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [serverName, setServerName] = useState('')
  // U6: il modello scritto a mano quando il servizio non elenca i suoi
  const [manualModel, setManualModel] = useState('')
  const { apiKey, baseUrl, probe, busy, group, effectiveBaseUrl, setApiKey, setBaseUrl, reset } = setup

  // il tipo già scelto da «Collega»: la scansione del Mac parte DA SOLA
  const scan = (): void => {
    setScanning(true)
    setFound(null)
    setScanError(false)
    void api.discoverProviders()
      .then((list) => setFound(list.filter((p) => p.discovered)))
      .catch(() => setScanError(true))
      .finally(() => setScanning(false))
  }
  useEffect(() => {
    if (kind === 'ollama' || kind === 'lmstudio') scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  const probeErrorText = (code: string): string =>
    code === 'invalid-key' ? t`La chiave non è valida`
      : code === 'unreachable' ? t`Il servizio non risponde`
        : t`La prova non è riuscita`

  const connect = async (): Promise<void> => {
    if (!kind) return
    const id = await setup.save({ name: group === 'server' ? (serverName.trim() || 'Server') : undefined })
    if (id) onSaved(id)
  }

  const q = query.trim().toLowerCase()
  const groups: Array<'mac' | 'key' | 'server'> = ['mac', 'key', 'server']
  const kindsOf = (g: 'mac' | 'key' | 'server'): ProviderKind[] =>
    CONNECTABLE_KINDS.filter((c) => c.group === g && (!q || KIND_LABELS[c.kind]!.toLowerCase().includes(q))).map((c) => c.kind)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div
        className="flex max-h-[min(640px,calc(100vh-64px))] w-full max-w-md flex-col overflow-hidden rounded-surface bg-card shadow-soft"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 pb-2 pt-5">
          {kind && (
            <Button variant="ghost" icon size="sm" aria-label={t`Indietro`} onClick={() => { setKind(null); setFound(null); reset() }}>
              <ChevronLeft className="size-4" />
            </Button>
          )}
          <strong className="text-title font-semibold">
            {kind ? <Trans>Collega {KIND_LABELS[kind] ?? ''}</Trans> : <Trans>Aggiungi provider</Trans>}
          </strong>
        </div>

        {/* passo 1 — l'elenco dei tipi, con ricerca */}
        {!kind && (
          <div className="flex min-h-0 flex-1 flex-col gap-block px-5 pb-5">
            {/* C4: la ricerca è UNA — SearchField, il pezzo del catalogo */}
            <SearchField value={query} onChange={setQuery} placeholder={t`Cerca (Ollama, Anthropic…)`} ariaLabel={t`Cerca (Ollama, Anthropic…)`} autoFocus className="w-full" />
            <div className="flex min-h-0 flex-1 flex-col gap-block overflow-y-auto scroll-thin pr-1.5">
              {groups.map((g) => {
                const kinds = kindsOf(g)
                if (kinds.length === 0) return null
                return (
                  // etichetta di gruppo + elenco a filo: le distanze di Section (12 dall'etichetta all'elenco)
                  <div key={g} className="flex flex-col gap-section-head">
                    <h3 className="text-caption font-medium text-muted-foreground">{i18n.t(GROUP_LABELS[g])}</h3>
                    <FlatList>
                      {kinds.map((k) => (
                        <FlatRow
                          key={k}
                          clickable
                          onClick={() => { setKind(k); reset() }}
                          leading={<ProviderMark kind={k} name={KIND_LABELS[k]!} size="sm" />}
                          title={KIND_LABELS[k]}
                          subtitle={g === 'mac'
                            ? <Trans>gratis, nessun dato esce</Trans>
                            : g === 'server' ? <Trans>qualsiasi servizio compatibile OpenAI</Trans> : undefined}
                          trailing={<span className="text-body text-primary"><Trans>Collega</Trans></span>}
                        />
                      ))}
                    </FlatList>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* passo 2 — i campi del tipo scelto */}
        {kind && group === 'mac' && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scroll-thin px-5 pb-5">
            <p className="text-small text-muted-foreground">
              {kind === 'ollama'
                ? <Trans>Cerco Ollama sul tuo Mac (porta 11434).</Trans>
                : <Trans>Cerco LM Studio sul tuo Mac (porta 1234).</Trans>}
            </p>
            <Button className="w-full" disabled={scanning} onClick={scan}>
              {scanning ? <Trans>Cerco…</Trans> : <Trans>Cerca di nuovo</Trans>}
            </Button>
            {scanError && <p className="text-small text-muted-foreground"><Trans>Non riesco a cercare sul Mac: riprova.</Trans></p>}
            {found !== null && (found.length > 0 ? (
              <div className="flex flex-col gap-1">
                <FlatList>
                  {found.map((p) => (
                    <FlatRow
                      key={p.id}
                      leading={<ProviderMark kind={p.kind} name={p.name} size="sm" />}
                      title={p.name}
                      trailing={<span className="text-body text-chart-2"><Trans>Collegato</Trans></span>}
                    />
                  ))}
                </FlatList>
                <button type="button" className={cn(LINK_BOTTONE, 'self-start')} onClick={onClose}>
                  <Trans>Fatto</Trans>
                </button>
              </div>
            ) : (
              <p className="text-small text-muted-foreground">
                <Trans>Non l’ho trovato. Aprilo e riprova, oppure inserisci l’indirizzo a mano:</Trans>{' '}
                <a className="text-primary hover:underline" href={kind === 'ollama' ? 'https://ollama.com' : 'https://lmstudio.ai'} target="_blank" rel="noreferrer">
                  {kind === 'ollama' ? 'ollama.com' : 'lmstudio.ai'}
                </a>
              </p>
            ))}
            {found !== null && found.length === 0 && (
              <div className="flex flex-col gap-2 pt-1">
                <button type="button" className={LINK_BOTTONE} onClick={() => setShowAdvanced((v) => !v)}>
                  <Trans>Avanzate</Trans>
                </button>
                {showAdvanced && (
                  <Input
                    className={cn(FIELD_PAGE_CLS, 'w-full')}
                    placeholder={kind === 'ollama' ? t`http://127.0.0.1:11434` : t`http://127.0.0.1:1234`}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                )}
                <Button
                  className="w-full"
                  disabled={busy || !baseUrl.trim()}
                  onClick={() => {
                    void (async () => {
                      const id = await setup.save()
                      if (id) onSaved(id)
                    })()
                  }}
                >
                  <Trans>Collega {KIND_LABELS[kind] ?? ''}</Trans>
                </Button>
              </div>
            )}
          </div>
        )}

        {kind && (group === 'key' || group === 'server') && (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scroll-thin px-5 pb-5">
            {group === 'server' && (
              <Input
                className={cn(FIELD_PAGE_CLS, 'w-full')}
                placeholder={t`Nome (es. Il mio gateway)`}
                value={serverName || suggestedNameOf(effectiveBaseUrl)}
                onChange={(e) => setServerName(e.target.value)}
              />
            )}
            <div>
              <button type="button" className={LINK_BOTTONE} onClick={() => setShowAdvanced((v) => !v)}>
                <Trans>Avanzate</Trans>
              </button>
              {showAdvanced && (
                <Input
                  className={cn(FIELD_PAGE_CLS, 'mt-1.5 w-full')}
                  placeholder={group === 'server' ? t`Indirizzo (es. http://127.0.0.1:8000/v1)` : t`Base URL`}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              )}
            </div>
            <label className="block text-small text-muted-foreground" htmlFor="sandbot-addprovider-key">
              {group === 'server' ? <Trans>La chiave (lasciala vuota se il server non la chiede)</Trans> : <Trans>Incolla la chiave</Trans>}
            </label>
            <Input
              id="sandbot-addprovider-key"
              className={cn(FIELD_PAGE_CLS, 'w-full')}
              type="password"
              placeholder={group === 'server' ? t`Chiave (facoltativa)` : t`sk-…`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            {probe.probing && <p className="text-small text-muted-foreground"><Trans>Provo la chiave…</Trans></p>}
            {probe.ok === true && probe.models.length > 0 && (
              <p className="text-body text-chart-2"><Trans>✓ Funziona · {probe.models.length} modelli disponibili</Trans></p>
            )}
            {probe.ok === true && probe.models.length === 0 && (
              /* U6: il servizio è raggiunto ma non elenca i modelli: si scrive a mano */
              <label className="block text-small text-muted-foreground">
                <Trans>Il servizio non elenca i modelli: scrivi il nome del modello</Trans>
                <Input
                  data-testid="sheet-manual-model"
                  className={cn(FIELD_PAGE_CLS, 'mt-1 w-full text-foreground')}
                  placeholder={t`es. llama-3.2-3b-instruct`}
                  value={manualModel}
                  onChange={(e) => setManualModel(e.target.value)}
                />
              </label>
            )}
            {probe.ok === false && <p className="text-body text-destructive">{probeErrorText(probe.error ?? 'error')}</p>}
            <p className="text-small text-muted-foreground"><Trans>La chiave resta nel Portachiavi del Mac.</Trans></p>
            <Button
              className="w-full"
              disabled={busy || !probe.ok || !effectiveBaseUrl.trim() || (group === 'server' && !serverName.trim())}
              onClick={() => void connect()}
            >
              <Trans>Collega {group === 'server' ? (serverName.trim() || t`il server`) : (KIND_LABELS[kind] ?? '')}</Trans>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
