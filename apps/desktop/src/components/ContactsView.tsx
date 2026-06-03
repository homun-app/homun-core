import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { coreBridge, type CoreContact, type CoreContactProfile } from "../lib/coreBridge";

/* First-class Contacts manager (M7): a searchable master-detail of every person
   the assistant knows, with type/notes, per-channel handles, conversation memory,
   merge suggestions and drag-and-drop merging. The merge itself is consistent
   server-side (SQL + graph relations + wiki + event-log) and self-protected. */

const CONTACT_TYPES: { value: string; label: string }[] = [
  { value: "unknown", label: "Da definire" },
  { value: "self", label: "Sono io" },
  { value: "family", label: "Famiglia" },
  { value: "friend", label: "Amico/a" },
  { value: "professional", label: "Professionale" },
  { value: "colleague", label: "Collega" },
  { value: "other", label: "Altro" },
];
function contactTypeLabel(value: string): string {
  return CONTACT_TYPES.find((t) => t.value === value)?.label ?? value;
}
function initial(name: string): string {
  const t = name.trim();
  return t ? t[0]!.toUpperCase() : "?";
}
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
function factTag(temporality: string): string {
  if (temporality === "transient") return "ora";
  if (temporality === "event") return "evento";
  return "sempre";
}

type MergePair = { from: CoreContact; into: CoreContact };

export function ContactsView() {
  const [contacts, setContacts] = useState<CoreContact[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [dragRef, setDragRef] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [pending, setPending] = useState<MergePair | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => setContacts(await coreBridge.contacts());
  useEffect(() => {
    void reload();
  }, []);

  const byRef = (reference: string) => contacts?.find((c) => c.reference === reference) ?? null;
  const open = selected ? byRef(selected) : null;

  // The detail card (keyed by reference) loads its own distilled profile.
  const selectContact = (reference: string) => setSelected(reference);

  // Merge suggestions: same normalized name across distinct (non-self) cards.
  const suggestions = useMemo(() => {
    if (!contacts) return [] as { name: string; refs: CoreContact[] }[];
    const groups = new Map<string, CoreContact[]>();
    for (const c of contacts) {
      if (c.is_self || !c.name.trim()) continue;
      const key = normalizeName(c.name);
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    return [...groups.values()]
      .filter((g) => g.length > 1)
      .map((g) => ({ name: g[0]!.name, refs: g }));
  }, [contacts]);

  const filtered = useMemo(() => {
    if (!contacts) return [];
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (typeFilter !== "all" && c.contact_type !== typeFilter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.channels.some((ch) => `${ch.channel}:${ch.address}`.toLowerCase().includes(q))
      );
    });
  }, [contacts, query, typeFilter]);

  // Normalize a merge so the user's own card (self) always survives.
  const openMerge = (from: CoreContact, into: CoreContact) => {
    if (from.reference === into.reference) return;
    const pair: MergePair = from.is_self ? { from: into, into: from } : { from, into };
    setError(null);
    setPending(pair);
  };

  const confirmMerge = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await coreBridge.mergeContacts(pending.from.reference, pending.into.reference);
      const survivor = pending.into.reference;
      setPending(null);
      await reload();
      selectContact(survivor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patch = async (update: { name?: string; contact_type?: string; notes?: string }) => {
    if (!open) return;
    setBusy(true);
    try {
      await coreBridge.updateContact({ reference: open.reference, ...update });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contacts-view">
      <div className="mdl-layout">
        <aside className="mdl-rail">
          <label className="chat-search-input">
            <Search size={16} />
            <input
              placeholder="Cerca per nome o canale"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <div className="contacts-chips">
            {[{ value: "all", label: "Tutti" }, ...CONTACT_TYPES].map((t) => (
              <button
                key={t.value}
                type="button"
                className={`contacts-chip ${typeFilter === t.value ? "active" : ""}`}
                onClick={() => setTypeFilter(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {suggestions.length > 0 && (
            <div className="contacts-suggest">
              <div className="contacts-suggest-title">Possibili duplicati</div>
              {suggestions.map((s) => (
                <div key={s.name} className="contacts-suggest-row">
                  <span>
                    «{s.name}» in {s.refs.length} schede
                  </span>
                  <button
                    type="button"
                    className="set-btn"
                    onClick={() => openMerge(s.refs[1]!, s.refs[0]!)}
                  >
                    Unisci
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mdl-rail-group">
            {filtered.length} {filtered.length === 1 ? "contatto" : "contatti"}
          </div>
          {filtered.map((c) => (
            <button
              key={c.reference}
              type="button"
              draggable
              className={`mdl-rail-item ${selected === c.reference ? "active" : ""} ${
                dragOver === c.reference ? "drag-over" : ""
              }`}
              onClick={() => void selectContact(c.reference)}
              onDragStart={() => setDragRef(c.reference)}
              onDragEnd={() => {
                setDragRef(null);
                setDragOver(null);
              }}
              onDragOver={(e) => {
                if (dragRef && dragRef !== c.reference) {
                  e.preventDefault();
                  setDragOver(c.reference);
                }
              }}
              onDragLeave={() => setDragOver((r) => (r === c.reference ? null : r))}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragRef ? byRef(dragRef) : null;
                setDragOver(null);
                setDragRef(null);
                if (from && from.reference !== c.reference) openMerge(from, c);
              }}
            >
              <span className="mdl-rail-avatar">{initial(c.name)}</span>
              <span className="mdl-rail-name">
                {c.name || "(senza nome)"}
                <small>
                  {contactTypeLabel(c.contact_type)}
                  {c.channels.length ? ` · ${c.channels.map((ch) => ch.channel).join(", ")}` : ""}
                </small>
              </span>
              {c.memory_count > 0 && <span className="mdl-rail-badge">{c.memory_count}</span>}
            </button>
          ))}
          {contacts && filtered.length === 0 && (
            <p className="set-hint">Nessun contatto. Arrivano dai canali (WhatsApp/Telegram).</p>
          )}
        </aside>

        <section className="mdl-detail">
          {!open ? (
            <p className="set-hint">Seleziona un contatto per vederne la scheda.</p>
          ) : (
            <ContactCard
              key={open.reference}
              contact={open}
              contacts={contacts ?? []}
              busy={busy}
              onPatch={patch}
              onMerge={(target) => openMerge(open, target)}
            />
          )}
        </section>
      </div>

      {pending && (
        <div className="contacts-modal-backdrop" onClick={() => !busy && setPending(null)}>
          <div className="contacts-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Unire i contatti?</h3>
            <p>
              <strong>«{pending.from.name || "(senza nome)"}»</strong> sparirà; i suoi canali e la
              sua memoria passano a <strong>«{pending.into.name || "(senza nome)"}»</strong>
              {pending.into.is_self ? " (te)" : ""}.
            </p>
            {error && <p className="set-hint" style={{ color: "var(--danger)" }}>{error}</p>}
            <div className="contacts-modal-actions">
              <button type="button" className="set-btn" disabled={busy} onClick={() => setPending(null)}>
                Annulla
              </button>
              <button
                type="button"
                className="set-btn primary"
                disabled={busy}
                onClick={() => void confirmMerge()}
              >
                Unisci
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ContactCard({
  contact,
  contacts,
  busy,
  onPatch,
  onMerge,
}: {
  contact: CoreContact;
  contacts: CoreContact[];
  busy: boolean;
  onPatch: (u: { name?: string; contact_type?: string; notes?: string }) => void;
  onMerge: (target: CoreContact) => void;
}) {
  const [mergeTarget, setMergeTarget] = useState("");
  const others = contacts.filter((c) => c.reference !== contact.reference);

  // Distilled profile (important facts, not the raw transcript). Cached server
  // side; we only trigger the (slow) extraction on explicit refresh.
  const [profile, setProfile] = useState<CoreContactProfile | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    setProfile(null);
    void coreBridge.contactProfile(contact.reference).then(setProfile);
  }, [contact.reference]);
  const refreshProfile = async () => {
    setRefreshing(true);
    try {
      setProfile(await coreBridge.refreshContactProfile(contact.reference));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="mdl-detail-head">
        <span className="contacts-avatar-lg">{initial(contact.name)}</span>
        <div>
          <h3 className="mdl-detail-title">
            {contact.name || "(senza nome)"}
            {contact.is_self ? " · tu" : ""}
          </h3>
          <p className="mdl-detail-sub">
            {contactTypeLabel(contact.contact_type)} · {contact.memory_count} messaggi
          </p>
        </div>
      </div>

      <div className="contacts-fields">
        <label className="rk">
          Nome
          <input
            className="set-input"
            defaultValue={contact.name}
            disabled={busy}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== contact.name) onPatch({ name: v });
            }}
          />
        </label>
        <label className="rk">
          Tipo di contatto
          <select
            className="set-input"
            value={contact.contact_type}
            disabled={busy}
            onChange={(e) => onPatch({ contact_type: e.target.value })}
          >
            {CONTACT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="rk" style={{ gridColumn: "1 / -1" }}>
          Note
          <input
            className="set-input"
            defaultValue={contact.notes}
            placeholder="es. fratello, collega di lavoro, cliente…"
            disabled={busy}
            onBlur={(e) => {
              if (e.target.value !== contact.notes) onPatch({ notes: e.target.value });
            }}
          />
        </label>
      </div>

      <div className="contacts-section">
        <div className="rk">Canali</div>
        {contact.channels.length ? (
          <div className="contacts-channels">
            {contact.channels.map((ch) => (
              <span key={`${ch.channel}:${ch.address}`} className="contacts-channel">
                {ch.channel} · {ch.address}
              </span>
            ))}
          </div>
        ) : (
          <p className="set-hint">Nessun canale collegato.</p>
        )}
      </div>

      <div className="contacts-section">
        <div className="contacts-section-head">
          <span className="rk">Cosa so di lui/lei</span>
          {profile && (profile.episode_count > 0 || profile.facts.length > 0) && (
            <button
              type="button"
              className="set-btn"
              disabled={refreshing}
              onClick={() => void refreshProfile()}
            >
              {refreshing
                ? "Analizzo…"
                : profile.facts.length === 0
                  ? "Genera dai messaggi"
                  : "Aggiorna"}
            </button>
          )}
        </div>
        {profile === null ? (
          <p className="set-hint">Carico…</p>
        ) : profile.facts.length === 0 ? (
          <p className="set-hint">
            {profile.episode_count === 0
              ? "Nessun messaggio ancora."
              : "Nessuna informazione estratta. Premi «Genera dai messaggi»."}
          </p>
        ) : (
          <>
            <ul className="contacts-facts">
              {profile.facts.map((f, i) => (
                <li key={i}>
                  <span className={`fact-tag ${f.temporality || "durable"}`}>
                    {factTag(f.temporality)}
                  </span>
                  <span className="fact-text">{f.text}</span>
                  {f.date && <span className="fact-date">{f.date}</span>}
                </li>
              ))}
            </ul>
            {profile.stale && (
              <p className="set-hint" style={{ marginBottom: 0 }}>
                Ci sono nuovi messaggi: «Aggiorna» per rigenerare il profilo.
              </p>
            )}
          </>
        )}
      </div>

      <div className="contacts-section">
        <div className="rk">Unisci a un altro contatto</div>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            className="set-input"
            value={mergeTarget}
            disabled={busy}
            onChange={(e) => setMergeTarget(e.target.value)}
            style={{ flex: 1 }}
          >
            <option value="">— scegli un contatto —</option>
            {others.map((o) => (
              <option key={o.reference} value={o.reference}>
                {o.name || o.reference}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="set-btn"
            disabled={busy || !mergeTarget}
            onClick={() => {
              const target = others.find((o) => o.reference === mergeTarget);
              if (target) onMerge(target);
            }}
          >
            Unisci
          </button>
        </div>
        <p className="set-hint" style={{ marginBottom: 0 }}>
          Suggerimento: puoi anche trascinare una scheda sull'altra per unirle.
        </p>
      </div>
    </>
  );
}
