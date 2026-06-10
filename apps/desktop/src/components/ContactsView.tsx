import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  coreBridge,
  type CoreContact,
  type CoreContactPerimeter,
  type CoreContactProfile,
  type CoreProfile,
  type CoreRelationship,
} from "../lib/coreBridge";

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

  const [profiles, setProfiles] = useState<CoreProfile[]>([]);
  const [showProfiles, setShowProfiles] = useState(false);

  const reload = async () => setContacts(await coreBridge.contacts());
  const reloadProfiles = async () => setProfiles(await coreBridge.profiles());
  useEffect(() => {
    void reload();
    void reloadProfiles();
  }, []);

  // Manual add — the curated path that isn't a channel identity (the other source
  // is inbound channel messages, which auto-create a contact).
  const newContact = async () => {
    const name = window.prompt("Nome del nuovo contatto");
    if (!name || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await coreBridge.createContact({ name: name.trim() });
      await reload();
      setSelected(created.reference);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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

  // Address-book grouping: sections by initial letter (accents folded, digits and
  // symbols under '#') + an alphabet index to jump — a flat list doesn't scale.
  const letterGroups = useMemo(() => {
    const letterOf = (name: string) => {
      const ch = (name.trim()[0] ?? "#")
        .toUpperCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
      return /[A-Z]/.test(ch) ? ch : "#";
    };
    const map = new Map<string, CoreContact[]>();
    for (const c of filtered) {
      const letter = letterOf(c.name);
      const group = map.get(letter);
      if (group) group.push(c);
      else map.set(letter, [c]);
    }
    return [...map.entries()].sort(([a], [b]) =>
      a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b),
    );
  }, [filtered]);

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

  const patch = async (update: {
    name?: string;
    contact_type?: string;
    notes?: string;
    tone_of_voice?: string;
    persona_instructions?: string;
    response_mode?: string;
    birthday?: string;
  }) => {
    if (!open) return;
    setBusy(true);
    try {
      await coreBridge.updateContact({ reference: open.reference, ...update });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const assignProfile = async (profileId: number | null, channel?: string) => {
    if (!open) return;
    setBusy(true);
    try {
      await coreBridge.assignContactProfile(open.reference, profileId, channel);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const removeContact = async () => {
    if (!open) return;
    if (!window.confirm(`Eliminare il contatto "${open.name}"? La memoria delle conversazioni resta.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await coreBridge.deleteContact(open.reference);
      setSelected(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contacts-view">
      {/* Toolbar (Apple-Contacts style): search + type filter + actions span the
          full width, so the left column is 100% list. */}
      <div className="contacts-toolbar">
        <label className="chat-search-input contacts-search">
          <Search size={16} />
          <input
            placeholder="Cerca per nome o canale"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          className="set-input contacts-type-select"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="all">Tutti i tipi</option>
          {CONTACT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="set-btn"
          onClick={() => void newContact()}
          disabled={busy}
        >
          + Nuovo contatto
        </button>
        <button type="button" className="set-btn" onClick={() => setShowProfiles(true)}>
          Profili
        </button>
      </div>

      {suggestions.length > 0 && (
        <div className="contacts-suggest contacts-suggest-banner">
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

      <div className="mdl-layout">
        <aside className="mdl-rail">
          <div className="mdl-rail-group">
            {filtered.length} {filtered.length === 1 ? "contatto" : "contatti"}
          </div>
          <div className="contacts-list-wrap">
            <div className="contacts-list">
              {letterGroups.map(([letter, items]) => (
                <div key={letter} id={`contacts-letter-${letter}`} className="contacts-letter-group">
                  <div className="contacts-letter">{letter}</div>
                  {items.map((c) => (
                    <button
                      key={c.reference}
                      type="button"
                      draggable
                      className={`mdl-rail-item contacts-row ${
                        selected === c.reference ? "active" : ""
                      } ${dragOver === c.reference ? "drag-over" : ""}`}
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
                          {c.channels.length
                            ? ` · ${c.channels.map((ch) => ch.channel).join(", ")}`
                            : ""}
                        </small>
                      </span>
                      {c.memory_count > 0 && (
                        <span className="mdl-rail-badge">{c.memory_count}</span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {letterGroups.length > 1 && (
              <div className="contacts-alpha" aria-label="Indice alfabetico">
                {letterGroups.map(([letter]) => (
                  <button
                    key={letter}
                    type="button"
                    onClick={() =>
                      document
                        .getElementById(`contacts-letter-${letter}`)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                  >
                    {letter}
                  </button>
                ))}
              </div>
            )}
          </div>
          {contacts && filtered.length === 0 && (
            <p className="set-hint">
              Nessun contatto. Arrivano dai canali (WhatsApp/Telegram) o aggiungili a mano.
            </p>
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
              profiles={profiles}
              busy={busy}
              onPatch={patch}
              onMerge={(target) => openMerge(open, target)}
              onDelete={() => void removeContact()}
              onAssignProfile={(profileId, channel) => void assignProfile(profileId, channel)}
            />
          )}
        </section>
      </div>

      {showProfiles && (
        <ProfilesModal
          profiles={profiles}
          onClose={() => setShowProfiles(false)}
          onReload={() => void reloadProfiles()}
        />
      )}

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
  profiles,
  busy,
  onPatch,
  onMerge,
  onDelete,
  onAssignProfile,
}: {
  contact: CoreContact;
  contacts: CoreContact[];
  profiles: CoreProfile[];
  busy: boolean;
  onPatch: (u: {
    name?: string;
    contact_type?: string;
    notes?: string;
    tone_of_voice?: string;
    persona_instructions?: string;
    response_mode?: string;
    birthday?: string;
  }) => void;
  onMerge: (target: CoreContact) => void;
  onDelete: () => void;
  onAssignProfile: (profileId: number | null, channel?: string) => void;
}) {
  const [mergeTarget, setMergeTarget] = useState("");
  const others = contacts.filter((c) => c.reference !== contact.reference);

  // Distilled profile (important facts, not the raw transcript). Cached server
  // side; we only trigger the (slow) extraction on explicit refresh.
  const [profile, setProfile] = useState<CoreContactProfile | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Isolation perimeter: what the assistant may see/use when replying to THIS
  // contact on a channel. Defaults are the safe deny-by-default profile.
  const [perimeter, setPerimeter] = useState<CoreContactPerimeter | null>(null);
  // Social graph: who this contact is to the other people in the rubrica.
  const [relations, setRelations] = useState<CoreRelationship[] | null>(null);
  const [relOther, setRelOther] = useState("");
  const [relType, setRelType] = useState("");
  const loadRelations = () =>
    void coreBridge
      .contactRelationships(contact.reference)
      .then(setRelations)
      .catch(() => setRelations([]));
  useEffect(() => {
    setProfile(null);
    setPerimeter(null);
    setRelations(null);
    void coreBridge.contactProfile(contact.reference).then(setProfile);
    void coreBridge
      .contactPerimeter(contact.reference)
      .then(setPerimeter)
      .catch(() => setPerimeter(null));
    void coreBridge
      .contactRelationships(contact.reference)
      .then(setRelations)
      .catch(() => setRelations([]));
  }, [contact.reference]);
  const savePerimeter = (next: CoreContactPerimeter) => {
    setPerimeter(next); // optimistic
    void coreBridge.setContactPerimeter(contact.reference, next).then(setPerimeter);
  };
  const refreshProfile = async () => {
    setRefreshing(true);
    try {
      setProfile(await coreBridge.refreshContactProfile(contact.reference));
    } finally {
      setRefreshing(false);
    }
  };

  // Delete a single fact structurally from the memory graph (cascade + reload).
  const forgetFact = async (reference: string) => {
    if (!reference) return;
    try {
      await coreBridge.decideMemory(reference, "delete");
      setProfile(await coreBridge.contactProfile(contact.reference));
    } catch {
      /* ignore */
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
        {!contact.is_self && (
          <button
            type="button"
            className="set-btn danger"
            style={{ marginLeft: "auto" }}
            disabled={busy}
            onClick={onDelete}
          >
            Elimina
          </button>
        )}
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
        <label className="rk">
          Compleanno
          <input
            type="date"
            className="set-input"
            defaultValue={contact.birthday ?? ""}
            disabled={busy}
            onBlur={(e) => {
              if ((e.target.value || "") !== (contact.birthday ?? ""))
                onPatch({ birthday: e.target.value });
            }}
          />
        </label>
        <label className="rk">
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
        <div className="rk">Persona e risposta</div>
        <div className="contacts-fields">
          {profiles.length > 0 && (
            <label className="rk">
              Profilo
              <select
                className="set-input"
                value={contact.profile_id ?? ""}
                disabled={busy}
                onChange={(e) =>
                  onAssignProfile(e.target.value ? Number(e.target.value) : null)
                }
              >
                <option value="">Nessuno (usa i campi qui sotto)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {profiles.length > 0 &&
            [...new Set(contact.channels.map((ch) => ch.channel))].map((channel) => (
              <label className="rk" key={channel}>
                Profilo su {channel}
                <select
                  className="set-input"
                  value={
                    contact.channel_profiles.find((cp) => cp.channel === channel)?.profile_id ?? ""
                  }
                  disabled={busy}
                  onChange={(e) =>
                    onAssignProfile(e.target.value ? Number(e.target.value) : null, channel)
                  }
                >
                  <option value="">Come il profilo base</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          <label className="rk">
            Modalità di risposta sui canali
            <select
              className="set-input"
              value={contact.response_mode}
              disabled={busy}
              onChange={(e) => onPatch({ response_mode: e.target.value })}
            >
              <option value="">Eredita (impostazioni canali)</option>
              <option value="automatic">Automatica — rispondi subito</option>
              <option value="draft">Bozza — registra senza rispondere</option>
              <option value="silent">Silenziosa — ignora i messaggi</option>
            </select>
          </label>
          <label className="rk">
            Tono di voce
            <input
              className="set-input"
              defaultValue={contact.tone_of_voice}
              placeholder="es. formale, amichevole, scherzoso…"
              disabled={busy}
              onBlur={(e) => {
                if (e.target.value !== contact.tone_of_voice)
                  onPatch({ tone_of_voice: e.target.value });
              }}
            />
          </label>
          <label className="rk" style={{ gridColumn: "1 / -1" }}>
            Istruzioni persona
            <input
              className="set-input"
              defaultValue={contact.persona_instructions}
              placeholder="es. è un cliente: professionale, dagli del lei, niente dettagli privati"
              disabled={busy}
              onBlur={(e) => {
                if (e.target.value !== contact.persona_instructions)
                  onPatch({ persona_instructions: e.target.value });
              }}
            />
          </label>
        </div>
      </div>

      <div className="contacts-section">
        <div className="rk">Perimetro (cosa può vedere l'assistente)</div>
        {perimeter === null ? (
          <p className="set-hint">Carico…</p>
        ) : (
          <div className="contacts-fields">
            <label className="rk">
              Memoria utilizzabile
              <select
                className="set-input"
                value={perimeter.memory_scope}
                disabled={busy}
                onChange={(e) => savePerimeter({ ...perimeter, memory_scope: e.target.value })}
              >
                <option value="contact_only">Solo la storia con questo contatto</option>
                <option value="personal">Anche la memoria personale (fidato)</option>
              </select>
            </label>
            <label className="rk">
              Strumenti vietati (separati da virgola)
              <input
                className="set-input"
                defaultValue={perimeter.tools_denied.join(", ")}
                placeholder="es. browser, recall_memory"
                disabled={busy}
                onBlur={(e) => {
                  const list = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  if (list.join("|") !== perimeter.tools_denied.join("|"))
                    savePerimeter({ ...perimeter, tools_denied: list });
                }}
              />
            </label>
            <label className="rk contacts-check">
              <input
                type="checkbox"
                checked={perimeter.can_see_contacts}
                disabled={busy}
                onChange={(e) =>
                  savePerimeter({ ...perimeter, can_see_contacts: e.target.checked })
                }
              />
              Può sentir nominare altri contatti
            </label>
            <label className="rk contacts-check">
              <input
                type="checkbox"
                checked={perimeter.can_see_calendar}
                disabled={busy}
                onChange={(e) =>
                  savePerimeter({ ...perimeter, can_see_calendar: e.target.checked })
                }
              />
              Può conoscere impegni e calendario
            </label>
          </div>
        )}
      </div>

      <div className="contacts-section">
        <div className="rk">Relazioni</div>
        {relations === null ? (
          <p className="set-hint">Carico…</p>
        ) : (
          <>
            {relations.length === 0 && (
              <p className="set-hint">Nessuna relazione registrata.</p>
            )}
            {relations.map((r) => (
              <div key={r.id} className="contacts-relation-row">
                <span>
                  {r.other_name} <small>({r.relationship_type})</small>
                </span>
                <button
                  type="button"
                  className="set-btn"
                  disabled={busy}
                  onClick={() => void coreBridge.removeRelationship(r.id).then(loadRelations)}
                >
                  Rimuovi
                </button>
              </div>
            ))}
            <div className="contacts-relation-add">
              <select
                className="set-input"
                value={relOther}
                disabled={busy}
                onChange={(e) => setRelOther(e.target.value)}
              >
                <option value="">Contatto…</option>
                {others.map((o) => (
                  <option key={o.reference} value={o.reference}>
                    {o.name}
                  </option>
                ))}
              </select>
              <input
                className="set-input"
                placeholder="relazione (es. moglie, collega, capo)"
                value={relType}
                disabled={busy}
                onChange={(e) => setRelType(e.target.value)}
              />
              <button
                type="button"
                className="set-btn"
                disabled={busy || !relOther || !relType.trim()}
                onClick={() =>
                  void coreBridge
                    .addRelationship(contact.reference, relOther, relType.trim())
                    .then(() => {
                      setRelOther("");
                      setRelType("");
                      loadRelations();
                    })
                }
              >
                Aggiungi
              </button>
            </div>
          </>
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
                <li key={f.reference || i}>
                  <span className={`fact-tag ${f.temporality || "durable"}`}>
                    {factTag(f.temporality)}
                  </span>
                  <span className="fact-text">{f.text}</span>
                  {f.date && <span className="fact-date">{f.date}</span>}
                  {f.reference && (
                    <button
                      type="button"
                      className="fact-forget"
                      title="Dimentica questa informazione"
                      aria-label="Dimentica"
                      onClick={() => void forgetFact(f.reference)}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
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

/** Manage the reusable named profiles ("Personale", "Lavoro"): persona presets a
 *  contact (or a single channel of a contact) adopts when the assistant replies. */
function ProfilesModal({
  profiles,
  onClose,
  onReload,
}: {
  profiles: CoreProfile[];
  onClose: () => void;
  onReload: () => void;
}) {
  const createNew = async () => {
    const name = window.prompt("Nome del profilo (es. Lavoro, Personale)");
    if (!name || !name.trim()) return;
    await coreBridge.createProfile({ name: name.trim() });
    onReload();
  };
  return (
    <div className="contacts-modal-backdrop" onClick={onClose}>
      <div className="contacts-modal contacts-profiles-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Profili di risposta</h3>
        <p className="set-hint">
          Persona riutilizzabili: tono e istruzioni che assegni ai contatti (anche per
          singolo canale, es. «Marco su Telegram → Lavoro»).
        </p>
        {profiles.length === 0 && <p className="set-hint">Nessun profilo ancora.</p>}
        {profiles.map((p) => (
          <div key={p.id} className="contacts-profile-row">
            <input
              className="set-input"
              defaultValue={p.name}
              placeholder="nome"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== p.name)
                  void coreBridge.updateProfile({ id: p.id, name: v }).then(onReload);
              }}
            />
            <input
              className="set-input"
              defaultValue={p.tone_of_voice}
              placeholder="tono (es. professionale)"
              onBlur={(e) => {
                if (e.target.value !== p.tone_of_voice)
                  void coreBridge
                    .updateProfile({ id: p.id, tone_of_voice: e.target.value })
                    .then(onReload);
              }}
            />
            <input
              className="set-input"
              defaultValue={p.instructions}
              placeholder="istruzioni (es. dai del lei, niente dettagli privati)"
              onBlur={(e) => {
                if (e.target.value !== p.instructions)
                  void coreBridge
                    .updateProfile({ id: p.id, instructions: e.target.value })
                    .then(onReload);
              }}
            />
            <button
              type="button"
              className="set-btn danger"
              title="Elimina profilo"
              onClick={() => {
                if (window.confirm(`Eliminare il profilo "${p.name}"?`))
                  void coreBridge.deleteProfile(p.id).then(onReload);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <div className="contacts-modal-actions">
          <button type="button" className="set-btn" onClick={() => void createNew()}>
            + Nuovo profilo
          </button>
          <button type="button" className="set-btn" onClick={onClose}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
