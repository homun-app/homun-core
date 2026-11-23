// Impostazioni → Vault (fase 14, punto 7): schede Login, Segreti, Contatti e
// Concessioni. I campi segreti sono di tipo password e NON si rileggono mai in
// chiaro nella UI: si possono solo SOSTITUIRE (salvare di nuovo). Le
// concessioni "Sempre per questo sito" di fill_credential sono revocabili da
// qui. Nessuna concessione generica: ogni riga è (login, origine).
// PP2 (fase plugin-pulita): la scheda «Dei plugin» (sola lettura) elenca i
// server MCP che hanno un segreto — il tipo e quanti, mai i valori — e rimanda
// alla scheda di ciascuno, dove il segreto si cambia. Icone lucide, mai emoji.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { KeyRound } from 'lucide-react'
import { api, useStore } from '../store'
// K4 (fase team-bot): il logo VERO dell'app quando il file c'è nel repo
import { logoUrlForName } from '../lib/app-logos'
import type { ServerSecretNames } from '../lib/plugin-secret'

/** Il template dei secret nei comandi (fase 17a): costante, così nel messaggio
 *  di Lingui è un segnaposto e non testo con doppie graffe (sintassi ICU). */
const SECRET_TEMPLATE = '{{secret:NOME}}'
import type { VaultItemInfoUi, FillGrantInfo } from '../../../shared/types'

type Scheda = 'login' | 'segreti' | 'plugins' | 'contatti' | 'concessioni'

/** I dati iniziali (per i test senza effect; nel prodotto si caricano dall'api). */
export interface VaultTabInitial {
  tab?: Scheda
  /** i secret dei comandi (scheda «Segreti») */
  secrets?: VaultItemInfoUi[]
  /** «Dei plugin»: i NOMI dei segreti (mcp:secret-names) e i server */
  plugins?: { names: ServerSecretNames[]; servers: Array<{ id: string; name: string }> }
}

export function VaultTab({ initial }: { initial?: VaultTabInitial }) {
  const { t } = useLingui()
  const [scheda, setScheda] = useState<Scheda>(initial?.tab ?? 'login')
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        <Trans>Il vault è cifrato a riposo (AES-256-GCM, chiave nel Keychain). I valori non si rileggono mai in chiaro: si possono solo sostituire. I bot vedono i nomi con <code>list-credentials</code> e i login si compilano con <code>fill_credential</code>, sempre col tuo consenso.</Trans>
      </p>
      <div className="flex flex-wrap gap-2" data-testid="vault-tabs">
        {([['login', t`Login`], ['segreti', t`Segreti`], ['plugins', t`Dei plugin`], ['contatti', t`Contatti`], ['concessioni', t`Concessioni`]] as const).map(([k, label]) => (
          <button
            key={k}
            className={`rounded-lg px-3 py-1.5 text-sm ${scheda === k ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setScheda(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {scheda === 'login' && <LoginsScheda />}
      {scheda === 'segreti' && <SecretsScheda initial={initial?.secrets} />}
      {scheda === 'plugins' && <PluginsScheda initial={initial?.plugins} />}
      {scheda === 'contatti' && <ContactsScheda />}
      {scheda === 'concessioni' && <GrantsScheda />}
    </div>
  )
}

function LoginsScheda() {
  const { t } = useLingui()
  const [items, setItems] = useState<VaultItemInfoUi[]>([])
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [origins, setOrigins] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [err, setErr] = useState('')

  const refresh = async () => setItems((await api.vaultItems()).filter((i) => i.kind === 'login'))
  useEffect(() => { void refresh() }, [])

  const save = async () => {
    setErr('')
    try {
      await api.vaultSaveLogin({
        label, origins: origins.split(/[\n,]/).map((o) => o.trim()).filter(Boolean),
        username, password, ...(totp ? { totp } : {})
      })
      setOpen(false); setLabel(''); setOrigins(''); setUsername(''); setPassword(''); setTotp('')
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-2">
      {items.map((l) => (
        <div key={l.key} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <span className="text-sm text-foreground">🔑 {l.label}</span>
          <span className="font-mono text-xs text-muted-foreground">{l.origins?.join(', ')}</span>
          {l.hasTotp && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-primary">TOTP</span>}
          <div className="flex-1" />
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              // modificare = sostituire: la UI non rilegge mai i valori
              setLabel(l.label); setOrigins((l.origins ?? []).join(', ')); setUsername(''); setPassword(''); setTotp(''); setOpen(true)
            }}
          >
            <Trans>sostituisci</Trans>
          </button>
          <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.vaultDeleteItem('login', l.key); await refresh() }}><Trans>elimina</Trans></button>
        </div>
      ))}
      {open ? (
        <div className="space-y-2 rounded-2xl border border-border bg-muted p-3">
          <input className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Etichetta (es. Portale ASPI)`} value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Origini https://… (separate da virgola)`} value={origins} onChange={(e) => setOrigins(e.target.value)} />
          <input type="password" autoComplete="off" className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Nome utente`} value={username} onChange={(e) => setUsername(e.target.value)} />
          <input type="password" autoComplete="new-password" className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Password`} value={password} onChange={(e) => setPassword(e.target.value)} />
          <input type="password" autoComplete="off" className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Segreto TOTP (opzionale)`} value={totp} onChange={(e) => setTotp(e.target.value)} />
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground" onClick={() => setOpen(false)}><Trans>Annulla</Trans></button>
            <button className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40" disabled={!label || !origins || !username || !password} onClick={() => void save()}><Trans>Salva</Trans></button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground hover:border-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
          <Trans>+ Aggiungi login</Trans>
        </button>
      )}
    </div>
  )
}

function SecretsScheda({ initial }: { initial?: VaultItemInfoUi[] }) {
  const { t } = useLingui()
  const [items, setItems] = useState<VaultItemInfoUi[]>(initial ?? [])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const refresh = async () => setItems((await api.vaultItems()).filter((i) => i.kind === 'secret'))
  // con i dati iniziali (i test) non si chiama l'api
  useEffect(() => { if (!initial) void refresh() }, [])
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground"><Trans>I secret servono ai COMANDI dei bot (<code>{SECRET_TEMPLATE}</code>): il valore entra solo nell'env del processo, mai nel transcript.</Trans></p>
      {items.map((sItem) => (
        <div key={sItem.key} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm text-foreground">{sItem.key}</span>
          <div className="flex-1" />
          <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.vaultDeleteItem('secret', sItem.key); await refresh() }}><Trans>elimina</Trans></button>
        </div>
      ))}
      <div className="flex gap-2">
        <input className="min-w-0 flex-1 rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Nome (es. API_KEY)`} value={name} onChange={(e) => setName(e.target.value)} />
        <input type="password" className="min-w-0 flex-1 rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Valore (sostituisce)`} value={value} onChange={(e) => setValue(e.target.value)} />
        <button
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
          disabled={!name.trim() || !value}
          onClick={async () => { await api.vaultStore(name.trim(), value); setName(''); setValue(''); await refresh() }}
        >
          <Trans>Salva</Trans>
        </button>
      </div>
    </div>
  )
}

function ContactsScheda() {
  const { t } = useLingui()
  const [items, setItems] = useState<VaultItemInfoUi[]>([])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [emails, setEmails] = useState('')
  const [phones, setPhones] = useState('')
  const [address, setAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const refresh = async () => setItems((await api.vaultItems()).filter((i) => i.kind === 'contact'))
  useEffect(() => { void refresh() }, [])
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground"><Trans>I contatti sono dati personali VISIBILI ai bot (servono a scrivere bozze) ma cifrati a riposo.</Trans></p>
      {items.map((c) => (
        <div key={c.key} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <span className="text-sm text-foreground">👤 {c.label}</span>
          <div className="flex-1" />
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={async () => {
              const full = await api.vaultGetContact(c.key)
              if (full) {
                setName(full.name); setEmails(full.emails.join(', ')); setPhones(full.phones.join(', '))
                setAddress(full.address ?? ''); setNotes(full.notes ?? '')
              }
              setOpen(true)
            }}
          >
            <Trans>modifica</Trans>
          </button>
          <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.vaultDeleteItem('contact', c.key); await refresh() }}><Trans>elimina</Trans></button>
        </div>
      ))}
      {open ? (
        <div className="space-y-2 rounded-2xl border border-border bg-muted p-3">
          <input className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Nome`} value={name} onChange={(e) => setName(e.target.value)} />
          <input className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Email (separate da virgola)`} value={emails} onChange={(e) => setEmails(e.target.value)} />
          <input className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Telefoni`} value={phones} onChange={(e) => setPhones(e.target.value)} />
          <input className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Indirizzo`} value={address} onChange={(e) => setAddress(e.target.value)} />
          <input className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Note`} value={notes} onChange={(e) => setNotes(e.target.value)} />
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground" onClick={() => setOpen(false)}><Trans>Annulla</Trans></button>
            <button
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
              disabled={!name.trim()}
              onClick={async () => {
                setErr('')
                try {
                  await api.vaultSaveContact({
                    name, emails: emails.split(/[,;]/).map((e) => e.trim()).filter(Boolean),
                    phones: phones.split(/[,;]/).map((p) => p.trim()).filter(Boolean),
                    ...(address ? { address } : {}), ...(notes ? { notes } : {})
                  })
                  setOpen(false); setName(''); setEmails(''); setPhones(''); setAddress(''); setNotes('')
                  await refresh()
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              <Trans>Salva</Trans>
            </button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground hover:border-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
          <Trans>+ Aggiungi contatto</Trans>
        </button>
      )}
    </div>
  )
}

function GrantsScheda() {
  const [grants, setGrants] = useState<FillGrantInfo[]>([])
  const refresh = async () => setGrants(await api.fillGrants())
  useEffect(() => { void refresh() }, [])
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground"><Trans>Le concessioni "Sempre per questo sito" del fill dei login: il bot compila QUEL login su QUELL'origine senza chiedere ogni volta. Revocabili una a una; non esistono concessioni generiche.</Trans></p>
      {grants.length === 0 && <p className="text-xs text-muted-foreground"><Trans>Nessuna concessione: ogni fill chiede la card.</Trans></p>}
      {grants.map((g) => (
        <div key={g.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <span className="text-sm text-foreground">🔑 {g.label}</span>
          <span className="font-mono text-xs text-muted-foreground">{g.origin}</span>
          <div className="flex-1" />
          <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.fillGrantRevoke(g.id); await refresh() }}><Trans>revoca</Trans></button>
        </div>
      ))}
    </div>
  )
}

/**
 * PP2: «Dei plugin» — SOLA LETTURA. Per ogni server MCP con un segreto: logo,
 * nome, di che segreto si tratta («token», «intestazioni: 2», «variabili
 * segrete: 3») e «Apri nella scheda ›», che chiude le Impostazioni e apre la
 * pagina Plugin con la scheda di quel server su «Account e bot». I nomi li
 * dà il daemon (mcp:secret-names): i valori non escono dallo store cifrato.
 */
function PluginsScheda({ initial }: { initial?: VaultTabInitial['plugins'] }) {
  const { t } = useLingui()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const openPlugin = useStore((s) => s.openPlugin)
  const [names, setNames] = useState<ServerSecretNames[] | null>(initial?.names ?? null)
  const [servers, setServers] = useState<Array<{ id: string; name: string }>>(initial?.servers ?? [])
  const [error, setError] = useState('')
  useEffect(() => {
    if (initial) return
    // i nomi dei segreti e i server arrivano INSIEME: la riga non mostra mai un id tecnico al posto del nome
    void Promise.all([api.mcpSecretNames(), api.mcpList().catch(() => [])])
      .then(([list, all]) => {
        setServers(all.map((s) => ({ id: s.id, name: s.name })))
        setNames(list)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  const typeOf = (n: ServerSecretNames): string => {
    const parts: string[] = []
    if (n.bearer) parts.push(t`token`)
    if (n.headers.length > 0) parts.push(t`intestazioni: ${n.headers.length}`)
    if (n.env.length > 0) parts.push(t`variabili segrete: ${n.env.length}`)
    return parts.join(' · ')
  }
  return (
    <div className="space-y-2" data-testid="vault-plugins">
      <p className="text-xs text-muted-foreground">
        <Trans>I token, le intestazioni e le variabili segrete dei plugin si cambiano nella scheda di ciascuno. Qui si vedono solo quali sono, mai i valori.</Trans>
      </p>
      {error !== '' && <p className="text-xs text-destructive">{error}</p>}
      {names !== null && names.length === 0 && (
        <p className="text-xs text-muted-foreground"><Trans>Nessun plugin con un segreto salvato.</Trans></p>
      )}
      {names?.map((n) => {
        const name = servers.find((s) => s.id === n.id)?.name ?? n.id
        const logo = logoUrlForName(name)
        return (
          <div key={n.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2" data-testid={`vault-plugin-row-${n.id}`}>
            {logo
              ? <img src={logo} alt="" className="size-8 shrink-0 rounded-[9px] object-cover dark:bg-white" />
              : <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-muted text-sm font-bold text-foreground/70" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground" data-testid={`vault-plugin-name-${n.id}`}>{name}</span>
              <span className="block truncate text-xs text-muted-foreground" data-testid={`vault-plugin-type-${n.id}`}>{typeOf(n)}</span>
            </span>
            <button
              type="button"
              className="shrink-0 text-xs text-muted-foreground transition hover:text-foreground"
              data-testid={`vault-plugin-open-${n.id}`}
              onClick={() => { setSettingsOpen(false); openPlugin({ kind: 'server', serverId: n.id, tab: 'accounts' }) }}
            >
              <Trans>Apri nella scheda ›</Trans>
            </button>
          </div>
        )
      })}
    </div>
  )
}
