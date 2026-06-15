import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
  { value: "unknown", label: "contacts.typeUnknown" },
  { value: "self", label: "contacts.typeSelf" },
  { value: "family", label: "contacts.typeFamily" },
  { value: "friend", label: "contacts.typeFriend" },
  { value: "professional", label: "contacts.typeProfessional" },
  { value: "colleague", label: "contacts.typeColleague" },
  { value: "other", label: "contacts.typeOther" },
];
function contactTypeLabel(value: string): string {
  return CONTACT_TYPES.find((ct) => ct.value === value)?.label ?? value;
}
function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "?";
}
/// Compact channel-response-mode chip for the contact list (only the meaningful modes;
/// "" inherit and "draft" show nothing). short = the chip glyph, title = the tooltip.
function responseModeBadgeKey(mode?: string): string | null {
  switch (mode) {
    case "automatic": return "contacts.modeAutomatic";
    case "approve": return "contacts.modeApprove";
    case "silent": return "contacts.modeSilent";
    default: return null;
  }
}
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
function factTagKey(temporality: string): string {
  if (temporality === "transient") return "contacts.factTransient";
  if (temporality === "event") return "contacts.factEvent";
  return "contacts.factPermanent";
}
/// Tonal variant for a fact chip: events are highlighted teal (.brand), everything
/// else stays neutral, matching the design's SEMPRE/EVENTO pills.
function factTagVariant(temporality: string): string {
  return temporality === "event" ? "brand" : "";
}

type MergePair = { from: CoreContact; into: CoreContact };

export function ContactsView() {
  const { t } = useTranslation();
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
    const name = window.prompt(t("contacts.promptNewContactName"));
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
          full width, so the grid below is 100% list. */}
      <div className="contacts-toolbar">
        <label className="set-search contacts-search">
          <Search size={15} />
          <input
            placeholder={t("contacts.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="set-select contacts-type-select">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">{t("contacts.allTypes")}</option>
            {CONTACT_TYPES.map((ct) => (
              <option key={ct.value} value={ct.value}>
                {ct.label}
              </option>
            ))}
          </select>
          <ChevronDown size={12} className="chev" />
        </div>
        <button
          type="button"
          className="set-btn primary"
          onClick={() => void newContact()}
          disabled={busy}
        >
          <Plus size={13} /> Nuovo contatto
        </button>
        <button type="button" className="set-btn" onClick={() => setShowProfiles(true)}>
          Profili
        </button>
      </div>

      {suggestions.length > 0 && (
        <div className="contacts-suggest contacts-suggest-banner">
          <div className="contacts-suggest-title">{t("contacts.possibleDuplicates")}</div>
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

      <div className="set-section-label contacts-count">
        {filtered.length} {filtered.length === 1 ? "contatto" : "contatti"}
      </div>

      <div className="contacts-grid-wrap">
        <div className="contacts-grid-scroll">
          {letterGroups.map(([letter, items]) => (
            <div key={letter} id={`contacts-letter-${letter}`} className="contacts-letter-group">
              {letterGroups.length > 1 && <div className="contacts-letter">{letter}</div>}
              <div className="set-cards-grid cols-2">
                {items.map((c) => {
                  const badge = responseModeBadgeKey(c.response_mode);
                  return (
                    <button
                      key={c.reference}
                      type="button"
                      draggable
                      className={`set-contact ${c.is_self ? "is-me" : ""} ${
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
                      <span className="set-contact-avatar">{initial(c.name)}</span>
                      <span className="set-contact-body">
                        <span className="set-contact-name">{c.name || "(senza nome)"}</span>
                        <span className="set-contact-sub">
                          {t(contactTypeLabel(c.contact_type))}
                          {c.channels.length
                            ? ` · ${c.channels.map((ch) => ch.channel).join(", ")}`
                            : ""}
                        </span>
                      </span>
                      {badge && (
                        <span
                          className={`contact-mode-badge mode-`}
                          title={t(badge)}
                        >
                          {c.response_mode === "automatic" ? "⚡" : c.response_mode === "approve" ? "✋" : "🔕"}
                        </span>
                      )}
                      {c.memory_count > 0 && (
                        <span className="set-contact-count">{c.memory_count}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {letterGroups.length > 1 && (
          <div className="contacts-alpha" aria-label={t("contacts.alphabetIndex")}>
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

      {open && (
        <div className="set-modal-overlay">
          <div className="set-modal-scrim" onClick={() => !busy && setSelected(null)} />
          <div className="set-modal wide contacts-sheet">
            <ContactCard
              key={open.reference}
              contact={open}
              contacts={contacts ?? []}
              profiles={profiles}
              busy={busy}
              onClose={() => setSelected(null)}
              onPatch={patch}
              onMerge={(target) => openMerge(open, target)}
              onDelete={() => void removeContact()}
              onAssignProfile={(profileId, channel) => void assignProfile(profileId, channel)}
            />
          </div>
        </div>
      )}

      {showProfiles && (
        <ProfilesModal
          profiles={profiles}
          onClose={() => setShowProfiles(false)}
          onReload={() => void reloadProfiles()}
        />
      )}

      {pending && (
        <div className="set-modal-overlay">
          <div className="set-modal-scrim" onClick={() => !busy && setPending(null)} />
          <div className="set-modal contacts-merge-modal">
            <h3 className="contacts-merge-title">Unire i contatti?</h3>
            <p className="contacts-merge-text">
              <strong>«{pending.from.name || "(senza nome)"}»</strong> sparirà; i suoi canali e la
              sua memoria passano a <strong>«{pending.into.name || "(senza nome)"}»</strong>
              {pending.into.is_self ? " (te)" : ""}.
            </p>
            {error && (
              <p className="set-hint" style={{ color: "var(--danger)" }}>
                {error}
              </p>
            )}
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
  onClose,
  onPatch,
  onMerge,
  onDelete,
  onAssignProfile,
}: {
  contact: CoreContact;
  contacts: CoreContact[];
  profiles: CoreProfile[];
  busy: boolean;
  onClose: () => void;
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
  const { t } = useTranslation();
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
      <div className="set-modal-head contacts-sheet-head">
        <span className={`set-contact-avatar lg ${contact.is_self ? "is-me" : ""}`}>
          {initial(contact.name)}
        </span>
        <div>
          <div className="mt">
            {contact.name || "(senza nome)"}
            {contact.is_self ? " · tu" : ""}
          </div>
          <div className="ms">
            {t(contactTypeLabel(contact.contact_type))} · {contact.memory_count} messaggi
          </div>
        </div>
        {!contact.is_self && (
          <button
            type="button"
            className="set-btn danger contacts-sheet-delete"
            disabled={busy}
            onClick={onDelete}
          >
            Elimina
          </button>
        )}
        <button type="button" className="set-modal-close" aria-label={t("contacts.close")} onClick={onClose}>
          <X size={17} />
        </button>
      </div>

      <div className="set-modal-body contacts-sheet-body">
        <div className="contacts-fields">
          <label className="contacts-field">
            <span className="set-modal-label">{t("contacts.name")}</span>
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
          <label className="contacts-field">
            <span className="set-modal-label">{t("contacts.contactType")}</span>
            <div className="set-select">
              <select
                value={contact.contact_type}
                disabled={busy}
                onChange={(e) => onPatch({ contact_type: e.target.value })}
              >
                {CONTACT_TYPES.map((ct) => (
                  <option key={ct.value} value={ct.value}>
                    {ct.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} className="chev" />
            </div>
          </label>
          <label className="contacts-field">
            <span className="set-modal-label">{t("contacts.birthday")}</span>
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
          <label className="contacts-field">
            <span className="set-modal-label">{t("contacts.notes")}</span>
            <input
              className="set-input"
              defaultValue={contact.notes}
              placeholder={t("contacts.notesPlaceholder")}
              disabled={busy}
              onBlur={(e) => {
                if (e.target.value !== contact.notes) onPatch({ notes: e.target.value });
              }}
            />
          </label>
        </div>

        <div className="contacts-section">
          <div className="set-modal-label">{t("contacts.channels")}</div>
          {contact.channels.length ? (
            <div className="contacts-channels">
              {contact.channels.map((ch) => (
                <span key={`${ch.channel}:${ch.address}`} className="set-tag contacts-channel-tag">
                  <span className="set-dot brand" />
                  {ch.channel} · {ch.address}
                </span>
              ))}
            </div>
          ) : (
            <p className="set-hint">Nessun canale collegato.</p>
          )}
        </div>

        <div className="contacts-section contacts-section-rule">
          <div className="contacts-section-title">Persona e risposta</div>
          <div className="contacts-fields">
            {profiles.length > 0 && (
              <label className="contacts-field">
                <span className="set-modal-label">Profilo</span>
                <div className="set-select">
                  <select
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
                  <ChevronDown size={12} className="chev" />
                </div>
              </label>
            )}
            {profiles.length > 0 &&
              [...new Set(contact.channels.map((ch) => ch.channel))].map((channel) => (
                <label className="contacts-field" key={channel}>
                  <span className="set-modal-label">Profilo su {channel}</span>
                  <div className="set-select">
                    <select
                      value={
                        contact.channel_profiles.find((cp) => cp.channel === channel)?.profile_id ??
                        ""
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
                    <ChevronDown size={12} className="chev" />
                  </div>
                </label>
              ))}
            <label className="contacts-field">
              <span className="set-modal-label">Modalità di risposta sui canali</span>
              <div className="set-select">
                <select
                  value={contact.response_mode}
                  disabled={busy}
                  onChange={(e) => onPatch({ response_mode: e.target.value })}
                >
                  <option value="">Eredita (impostazioni canali)</option>
                  <option value="automatic">Automatica — rispondi subito</option>
                  <option value="approve">
                    Approva — preparo la risposta, la confermi prima dell'invio
                  </option>
                  <option value="draft">Bozza — registra senza rispondere</option>
                  <option value="silent">Silenziosa — non rispondere a questo contatto</option>
                </select>
                <ChevronDown size={12} className="chev" />
              </div>
            </label>
            <label className="contacts-field">
              <span className="set-modal-label">Tono di voce</span>
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
            <label className="contacts-field contacts-field-wide">
              <span className="set-modal-label">Istruzioni persona</span>
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

        <div className="contacts-section contacts-section-rule">
          <div className="contacts-section-title">
            Perimetro <span className="contacts-section-note">(cosa può vedere l'assistente)</span>
          </div>
          {perimeter === null ? (
            <p className="set-hint">Carico…</p>
          ) : (
            <>
              <div className="contacts-fields">
                <label className="contacts-field">
                  <span className="set-modal-label">Memoria utilizzabile</span>
                  <div className="set-select">
                    <select
                      value={perimeter.memory_scope}
                      disabled={busy}
                      onChange={(e) => savePerimeter({ ...perimeter, memory_scope: e.target.value })}
                    >
                      <option value="contact_only">Solo la storia con questo contatto</option>
                      <option value="personal">Anche la memoria personale (fidato)</option>
                    </select>
                    <ChevronDown size={12} className="chev" />
                  </div>
                </label>
                <label className="contacts-field">
                  <span className="set-modal-label">Strumenti vietati (separati da virgola)</span>
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
              </div>
              <div className="contacts-checks">
                <label className="contacts-check">
                  <input
                    type="checkbox"
                    checked={perimeter.can_see_contacts}
                    disabled={busy}
                    onChange={(e) =>
                      savePerimeter({ ...perimeter, can_see_contacts: e.target.checked })
                    }
                  />
                  <span className="contacts-check-box" aria-hidden="true">
                    <Check size={11} />
                  </span>
                  Può sentir nominare altri contatti
                </label>
                <label className="contacts-check">
                  <input
                    type="checkbox"
                    checked={perimeter.can_see_calendar}
                    disabled={busy}
                    onChange={(e) =>
                      savePerimeter({ ...perimeter, can_see_calendar: e.target.checked })
                    }
                  />
                  <span className="contacts-check-box" aria-hidden="true">
                    <Check size={11} />
                  </span>
                  Può conoscere impegni e calendario
                </label>
              </div>
            </>
          )}
        </div>

        <div className="contacts-section contacts-section-rule">
          <div className="contacts-section-title">Relazioni</div>
          {relations === null ? (
            <p className="set-hint">Carico…</p>
          ) : (
            <>
              {relations.length === 0 && (
                <p className="set-hint contacts-rel-empty">Nessuna relazione registrata.</p>
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
                <div className="set-select contacts-relation-select">
                  <select
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
                  <ChevronDown size={12} className="chev" />
                </div>
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

        <div className="contacts-section contacts-section-rule">
          <div className="contacts-section-head">
            <span className="contacts-section-title">Cosa so di lui/lei</span>
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
            <div className="set-line-list contacts-facts">
              {profile.facts.map((f, i) => (
                <div key={f.reference || i} className="set-line-item contacts-fact">
                  <span className={`set-tag ${factTagVariant(f.temporality)} contacts-fact-tag`}>
                    {t(factTagKey(f.temporality))}
                  </span>
                  <span className="contacts-fact-text">{f.text}</span>
                  {f.date && <span className="set-mono-faint contacts-fact-date">{f.date}</span>}
                  {f.reference && (
                    <button
                      type="button"
                      className="contacts-fact-forget"
                      title="Dimentica questa informazione"
                      aria-label={t("contacts.forget")}
                      onClick={() => void forgetFact(f.reference)}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="contacts-section contacts-section-rule">
          <div className="set-modal-label">Unisci a un altro contatto</div>
          <div className="contacts-merge-row">
            <div className="set-select contacts-merge-select">
              <select
                value={mergeTarget}
                disabled={busy}
                onChange={(e) => setMergeTarget(e.target.value)}
              >
                <option value="">— scegli un contatto —</option>
                {others.map((o) => (
                  <option key={o.reference} value={o.reference}>
                    {o.name || o.reference}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} className="chev" />
            </div>
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
          <p className="set-hint contacts-merge-hint">
            Suggerimento: puoi anche trascinare una scheda sull'altra per unirle.
          </p>
        </div>
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
  const { t } = useTranslation();
  const createNew = async () => {
    const name = window.prompt("Nome del profilo (es. Lavoro, Personale)");
    if (!name || !name.trim()) return;
    await coreBridge.createProfile({ name: name.trim() });
    onReload();
  };
  return (
    <div className="set-modal-overlay">
      <div className="set-modal-scrim" onClick={onClose} />
      <div className="set-modal contacts-profiles-modal">
        <div className="set-modal-head">
          <div>
            <div className="mt">Profili di risposta</div>
            <div className="ms">
              Persona riutilizzabili: tono e istruzioni che assegni ai contatti (anche per singolo
              canale, es. «Marco su Telegram → Lavoro»).
            </div>
          </div>
          <button type="button" className="set-modal-close" aria-label="Chiudi" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="set-modal-body">
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
                className="set-btn danger contacts-profile-del"
                title="Elimina profilo"
                onClick={() => {
                  if (window.confirm(`Eliminare il profilo "${p.name}"?`))
                    void coreBridge.deleteProfile(p.id).then(onReload);
                }}
              >
                <X size={15} />
              </button>
            </div>
          ))}
          <div className="contacts-modal-actions">
            <button type="button" className="set-btn primary" onClick={() => void createNew()}>
              <Plus size={13} /> Nuovo profilo
            </button>
            <button type="button" className="set-btn" onClick={onClose}>
              Chiudi
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
