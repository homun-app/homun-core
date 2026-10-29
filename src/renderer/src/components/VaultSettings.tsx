// Impostazioni → Vault (fase 14, punto 7): schede Login, Segreti, Contatti e
// Concessioni. I campi segreti sono di tipo password e NON si rileggono mai in
// chiaro nella UI: si possono solo SOSTITUIRE (salvare di nuovo). Le
// concessioni "Sempre per questo sito" di fill_credential sono revocabili da
// qui. Nessuna concessione generica: ogni riga è (login, origine).
import { useEffect, useState } from 'react'
import { api } from '../store'
import type { VaultItemInfoUi, FillGrantInfo } from '../../../shared/types'

export function VaultTab() {
  const [scheda, setScheda] = useState<'login' | 'segreti' | 'contatti' | 'concessioni'>('login')
  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        Il vault è cifrato a riposo (AES-256-GCM, chiave nel Keychain). I valori non si rileggono mai in chiaro: si possono solo sostituire. I bot vedono i nomi con <code>list-credentials</code> e i login si compilano con <code>fill_credential</code>, sempre col tuo consenso.
      </p>
      <div className="flex gap-2">
        {([['login', 'Login'], ['segreti', 'Segreti'], ['contatti', 'Contatti'], ['concessioni', 'Concessioni']] as const).map(([k, label]) => (
          <button
            key={k}
            className={`rounded-lg px-3 py-1.5 text-sm ${scheda === k ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}
            onClick={() => setScheda(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {scheda === 'login' && <LoginsScheda />}
      {scheda === 'segreti' && <SecretsScheda />}
      {scheda === 'contatti' && <ContactsScheda />}
      {scheda === 'concessioni' && <GrantsScheda />}
    </div>
  )
}

function LoginsScheda() {
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
        <div key={l.key} className="flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2">
          <span className="text-sm text-neutral-200">🔑 {l.label}</span>
          <span className="font-mono text-xs text-neutral-500">{l.origins?.join(', ')}</span>
          {l.hasTotp && <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-sky-400">TOTP</span>}
          <div className="flex-1" />
          <button
            className="text-xs text-neutral-500 hover:text-neutral-300"
            onClick={() => {
              // modificare = sostituire: la UI non rilegge mai i valori
              setLabel(l.label); setOrigins((l.origins ?? []).join(', ')); setUsername(''); setPassword(''); setTotp(''); setOpen(true)
            }}
          >
            sostituisci
          </button>
          <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.vaultDeleteItem('login', l.key); await refresh() }}>elimina</button>
        </div>
      ))}
      {open ? (
        <div className="space-y-2 rounded-xl border border-neutral-700 bg-neutral-900 p-3">
          <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Etichetta (es. Portale ASPI)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Origini https://… (separate da virgola)" value={origins} onChange={(e) => setOrigins(e.target.value)} />
          <input type="password" autoComplete="off" className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Nome utente" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input type="password" autoComplete="new-password" className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input type="password" autoComplete="off" className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Segreto TOTP (opzionale)" value={totp} onChange={(e) => setTotp(e.target.value)} />
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className="rounded-lg px-3 py-1.5 text-xs text-neutral-400" onClick={() => setOpen(false)}>Annulla</button>
            <button className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40" disabled={!label || !origins || !username || !password} onClick={() => void save()}>Salva</button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-xl border border-dashed border-neutral-700 px-3 py-2.5 text-sm text-neutral-500 hover:border-neutral-500 hover:text-neutral-300" onClick={() => setOpen(true)}>
          + Aggiungi login
        </button>
      )}
    </div>
  )
}

function SecretsScheda() {
  const [items, setItems] = useState<VaultItemInfoUi[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const refresh = async () => setItems((await api.vaultItems()).filter((i) => i.kind === 'secret'))
  useEffect(() => { void refresh() }, [])
  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500">I secret servono ai COMANDI dei bot (<code>{'{{secret:NOME}}'}</code>): il valore entra solo nell'env del processo, mai nel transcript.</p>
      {items.map((sItem) => (
        <div key={sItem.key} className="flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2">
          <span className="text-sm text-neutral-200">🔐 {sItem.key}</span>
          <div className="flex-1" />
          <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.vaultDeleteItem('secret', sItem.key); await refresh() }}>elimina</button>
        </div>
      ))}
      <div className="flex gap-2">
        <input className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Nome (es. API_KEY)" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="password" className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Valore (sostituisce)" value={value} onChange={(e) => setValue(e.target.value)} />
        <button
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          disabled={!name.trim() || !value}
          onClick={async () => { await api.vaultStore(name.trim(), value); setName(''); setValue(''); await refresh() }}
        >
          Salva
        </button>
      </div>
    </div>
  )
}

function ContactsScheda() {
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
      <p className="text-xs text-neutral-500">I contatti sono dati personali VISIBILI ai bot (servono a scrivere bozze) ma cifrati a riposo.</p>
      {items.map((c) => (
        <div key={c.key} className="flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2">
          <span className="text-sm text-neutral-200">👤 {c.label}</span>
          <div className="flex-1" />
          <button
            className="text-xs text-neutral-500 hover:text-neutral-300"
            onClick={async () => {
              const full = await api.vaultGetContact(c.key)
              if (full) {
                setName(full.name); setEmails(full.emails.join(', ')); setPhones(full.phones.join(', '))
                setAddress(full.address ?? ''); setNotes(full.notes ?? '')
              }
              setOpen(true)
            }}
          >
            modifica
          </button>
          <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.vaultDeleteItem('contact', c.key); await refresh() }}>elimina</button>
        </div>
      ))}
      {open ? (
        <div className="space-y-2 rounded-xl border border-neutral-700 bg-neutral-900 p-3">
          <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Email (separate da virgola)" value={emails} onChange={(e) => setEmails(e.target.value)} />
          <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Telefoni" value={phones} onChange={(e) => setPhones(e.target.value)} />
          <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Indirizzo" value={address} onChange={(e) => setAddress(e.target.value)} />
          <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Note" value={notes} onChange={(e) => setNotes(e.target.value)} />
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className="rounded-lg px-3 py-1.5 text-xs text-neutral-400" onClick={() => setOpen(false)}>Annulla</button>
            <button
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
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
              Salva
            </button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-xl border border-dashed border-neutral-700 px-3 py-2.5 text-sm text-neutral-500 hover:border-neutral-500 hover:text-neutral-300" onClick={() => setOpen(true)}>
          + Aggiungi contatto
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
      <p className="text-xs text-neutral-500">Le concessioni "Sempre per questo sito" del fill dei login: il bot compila QUEL login su QUELL'origine senza chiedere ogni volta. Revocabili una a una; non esistono concessioni generiche.</p>
      {grants.length === 0 && <p className="text-xs text-neutral-600">Nessuna concessione: ogni fill chiede la card.</p>}
      {grants.map((g) => (
        <div key={g.id} className="flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2">
          <span className="text-sm text-neutral-200">🔑 {g.label}</span>
          <span className="font-mono text-xs text-neutral-500">{g.origin}</span>
          <div className="flex-1" />
          <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.fillGrantRevoke(g.id); await refresh() }}>revoca</button>
        </div>
      ))}
    </div>
  )
}
