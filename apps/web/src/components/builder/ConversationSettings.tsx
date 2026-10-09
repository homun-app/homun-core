import { useEffect, useRef, useState } from "react";
import { Check, ArrowLeft, Search } from "lucide-react";
import { ConversationUpdateStatus } from "./ConversationUpdateStatus";
import { ConversationSelect } from "./ConversationSelect";
import { ConversationUnifiedModelsSection } from "./ConversationUnifiedModelsSection";
import { ConversationBudgetSettingsSection } from "./ConversationModelsSettingsSection";
import { EnginePeopleSection } from "./EnginePeopleSection";
import { EngineRemoteSpacesSection } from "./EngineRemoteSpacesSection";
import { ConversationAutomationsSettingsSection } from "./ConversationAutomationsSettingsSection";
import { ConversationReviewQueuesSection } from "./ConversationReviewQueuesSection";
import { ConversationMemorySettingsSection } from "./ConversationMemorySettingsSection";
import { ConversationAgentsSettingsSection } from "./ConversationAgentsSettingsSection";
import { ConversationSkillsSettingsSection } from "./ConversationSkillsSettingsSection";
import { ConversationEngineMaintenanceSection } from "./ConversationEngineMaintenanceSection";
import { CapabilitiesView } from "./capabilities/CapabilitiesView";
import { MessagingView } from "./messaging/MessagingView";
import { type ConversationPreferences } from "./conversation-preferences";
import { SETTINGS_NAV_GROUPS } from "./conversation-settings-nav";
import { setLanguage } from "@/lib/i18n";
import "./conversation-settings.css";

export function ConversationSettings({
  value,
  onSave,
  onClose,
  onNavigate,
  onExport,
  onReset,
  onRestore,
  archived,
  storageStatus,
  counts,
  initialSection = "space",
}: {
  value: ConversationPreferences;
  onSave: (p: ConversationPreferences) => void;
  onClose: () => void;
  onNavigate: (page: "Squadra" | "Plugin" | "Materiali" | "Progetti") => void;
  onExport: () => void;
  onReset: () => Promise<void>;
  onRestore: (id: string) => void;
  archived: { id: string; title: string }[];
  storageStatus: string;
  counts: { works: number; projects: number; materials: number | null };
  /** Open a specific settings section (e.g. models from first-run CTA). */
  initialSection?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState(initialSection);
  const [navSearch, setNavSearch] = useState("");
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  const [resetText, setResetText] = useState("");
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const [resetting, setResetting] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(draft);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);
  function change<K extends keyof ConversationPreferences>(key: K, v: ConversationPreferences[K]) {
    setDraft((p) => ({ ...p, [key]: v }));
    setSaved(false);
  }
  function close() {
    if (dirty) setDiscard(true);
    else onClose();
  }
  const valid =
    draft.spaceName.trim() &&
    draft.displayName.trim() &&
    Number.isFinite(draft.budget) &&
    draft.budget >= 0 &&
    draft.perWorkBudget >= 0 &&
    draft.perWorkBudget <= draft.budget;

  const filteredGroups = SETTINGS_NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) =>
      item.label.toLowerCase().includes(navSearch.trim().toLowerCase()),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <dialog
      ref={dialog}
      className="cv-settings-dialog"
      aria-label="Impostazioni dello spazio"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="cv-settings-layout">
        <aside className="cv-settings-sidebar">
          <div className="cv-settings-sidebar__top">
            <button
              type="button"
              className="cv-settings-back-btn"
              onClick={close}
            >
              <ArrowLeft size={16} />
              <span>Torna all'app</span>
            </button>
            <div className="cv-settings-nav-search">
              <Search size={14} />
              <input
                type="text"
                placeholder="Cerca impostazioni…"
                value={navSearch}
                onChange={(e) => setNavSearch(e.target.value)}
              />
            </div>
          </div>

          <nav className="cv-settings-sidebar__nav" aria-label="Categorie impostazioni">
            {filteredGroups.map((group) => (
              <div
                key={group.title}
                className={`cv-settings-nav-group cv-settings-nav-group--${group.level}`}
              >
                <span className="cv-settings-nav-group__title">{group.title}</span>
                <div className="cv-settings-nav-group__items">
                  {group.items.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`cv-settings-nav-item ${section === s.id ? "is-active" : ""}`}
                      aria-current={section === s.id ? "page" : undefined}
                      onClick={() => {
                        setSection(s.id);
                        setError("");
                        setDiscard(false);
                      }}
                    >
                      <s.icon size={16} />
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>
        <section className="cv-settings-body">
          {section === "space" && (
            <>
              <h3>Il tuo spazio di lavoro</h3>
              <p>Un nome riconoscibile per la tua squadra.</p>
              <label>
                Nome dello spazio
                <input
                  value={draft.spaceName}
                  maxLength={60}
                  onChange={(e) => change("spaceName", e.target.value)}
                />
              </label>
              <label>
                Il tuo nome visualizzato
                <input
                  value={draft.displayName}
                  maxLength={50}
                  onChange={(e) => change("displayName", e.target.value)}
                />
              </label>
              <label>
                Azienda <span>facoltativo</span>
                <input
                  value={draft.company}
                  maxLength={100}
                  onChange={(e) => change("company", e.target.value)}
                />
              </label>
              
            </>
          )}
          {section === "preferences" && (
            <>
              <h3>Un’interfaccia comoda per te</h3>
              <p>Le preferenze valgono per questo browser.</p>
              <label>
                Lingua dell’interfaccia
                <ConversationSelect
                  label="Lingua dell’interfaccia"
                  value={draft.language ?? "it"}
                  options={[
                    { value: "it", label: "Italiano" },
                    { value: "en", label: "English" },
                  ]}
                  onChange={(v) => {
                    const lang = v as "it" | "en";
                    change("language", lang);
                    setLanguage(lang);
                  }}
                />
              </label>
              <label>
                Dimensione del testo
                <ConversationSelect
                  label="Dimensione del testo"
                  value={draft.textSize}
                  options={[
                    { value: "standard", label: "Standard" },
                    { value: "large", label: "Più grande" },
                  ]}
                  onChange={(v) => change("textSize", v as ConversationPreferences["textSize"])}
                />
              </label>
              <label className="cv-settings-toggle">
                <span>
                  <strong>Animazioni</strong>
                  <small>
                    Scorrimenti e transizioni; viene rispettata anche la preferenza del sistema.
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.motion}
                  onChange={(e) => change("motion", e.target.checked)}
                />
              </label>
              <div className="cv-settings-card">
                <strong>Scorciatoie</strong>
                <p>
                  {/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} K · Cerca ovunque
                  <br />
                  Invio · Invia il messaggio
                  <br />
                  Maiusc + Invio · Vai a capo
                  <br />
                  Esc · Chiudi finestre e menu
                </p>
              </div>
            </>
          )}
          {section === "notifications" && <MessagingView />}
          {section === "models" && (
            <ConversationUnifiedModelsSection onNavigateSection={(sec) => setSection(sec)} />
          )}
          {section === "budget" && (
            <ConversationBudgetSettingsSection draft={draft} onChange={change} />
          )}
          {section === "people" && <EnginePeopleSection />}
          {section === "remote-spaces" && <EngineRemoteSpacesSection />}
          {(section === "plugins" || section === "skills") && <CapabilitiesView />}
          {section === "automations" && <ConversationAutomationsSettingsSection />}
          {section === "review" && <ConversationReviewQueuesSection actorId="person_fabio" />}
          {section === "agents" && <ConversationAgentsSettingsSection actorId="person_fabio" />}
          {section === "skills" && <ConversationSkillsSettingsSection actorId="person_fabio" />}
          {section === "projects" && (
            <div className="cv-settings-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Project Hub</h3>
              <p style={{ margin: 0, color: "#5a6e5a" }}>I progetti sono ora gestiti in modo dedicato nel nuovo Project Hub.</p>
              <button
                type="button"
                className="cv-settings-btn-primary"
                onClick={() => {
                  onClose();
                  onNavigate("Progetti");
                }}
              >
                Apri Project Hub →
              </button>
            </div>
          )}
          {section === "memory" && (
            <ConversationMemorySettingsSection actorId="person_fabio" />
          )}
          {section === "engine" && <ConversationEngineMaintenanceSection />}
          {section === "archive" && (
            <>
              <h3>Conversazioni archiviate</h3>
              <p>Restano salvate qui. Ripristinale per riportarle fra i lavori attivi.</p>
              {!archived.length ? (
                <div className="cv-settings-card">Nessuna conversazione archiviata.</div>
              ) : (
                archived.map((w) => (
                  <div className="cv-archive-row" key={w.id}>
                    <strong>{w.title}</strong>
                    <button className="cw-secondary" onClick={() => onRestore(w.id)}>
                      Ripristina
                    </button>
                  </div>
                ))
              )}
            </>
          )}
          {import.meta.env.DEV && section === "data" && (
            <>
              <h3>I dati della prova</h3>
              <p>{storageStatus}</p>
              <div className="cv-settings-grid cv-settings-card">
                <span>
                  <strong>{counts.works}</strong> lavori
                </span>
                <span>
                  <strong>{counts.projects}</strong> progetti
                </span>
                <span>
                  <strong>{counts.materials ?? "nei progetti"}</strong> materiali
                </span>
              </div>
              <p>
                I dati e gli allegati sono conservati in questo browser. Non sono sincronizzati con
                altri dispositivi. Cancellare i dati del browser li rimuove.
              </p>
              <button className="cw-secondary" onClick={onExport}>
                Esporta riepilogo JSON
              </button>
              <small className="cv-settings-note">
                Include conversazioni, piani e configurazioni. Per i file include soltanto nome e
                metadati, non il contenuto.
              </small>
              <div className="cv-settings-card">
                <strong>Riparti dalla demo iniziale</strong>
                <p>
                  Cancella le modifiche salvate per questa demo. Gli altri ambienti di prova e i
                  file originali sul computer restano intatti.
                </p>
                <label>
                  Scrivi RIPRISTINA per confermare
                  <input
                    value={resetText}
                    onChange={(e) => setResetText(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button
                  className="cv-danger"
                  disabled={resetText !== "RIPRISTINA" || resetting}
                  onClick={async () => {
                    setResetting(true);
                    try {
                      await onReset();
                    } catch {
                      setError(
                        "Non è stato possibile ripristinare. I dati non sono stati rimossi.",
                      );
                      setResetting(false);
                    }
                  }}
                >
                  {resetting ? "Ripristino…" : "Ripristina questa demo"}
                </button>
              </div>
            </>
          )}
          {section === "help" && (
            <>
              <ConversationUpdateStatus />
              <h3>Da una richiesta a un risultato</h3>
              <ol className="cv-settings-guide">
                <li>
                  <strong>Scrivi cosa vuoi ottenere.</strong>
                  <p>Usa @ per scegliere un collaboratore e allega ciò che serve.</p>
                </li>
                <li>
                  <strong>Controlla il piano.</strong>
                  <p>Modifica i passaggi e i responsabili, poi avvia il lavoro.</p>
                </li>
                <li>
                  <strong>Rispondi quando serve.</strong>
                  <p>Le notifiche portano alla richiesta, nella conversazione.</p>
                </li>
                <li>
                  <strong>Verifica la consegna.</strong>
                  <p>
                    Apri il risultato, chiedi modifiche o approva. L’approvazione non invia nulla
                    all’esterno.
                  </p>
                </li>
              </ol>
              {import.meta.env.DEV && (
                <>
                  <div className="cv-settings-card">
                    <strong>Cosa è simulato</strong>
                    <p>
                      AI, esecuzioni, connessioni, inviti, permessi e costi. La chat riconosce esempi
                      guidati e alcune istruzioni: non interpreta qualsiasi richiesta.
                    </p>
                  </div>
                  <div className="cv-settings-links">
                    <a href="/?work-demo=busy&edition=complete">
                      Demo con 18 lavori ↗
                    </a>
                    <a href="/">Spazio libero ↗</a>
                  </div>
                </>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="cv-settings-error">
              {error}
            </p>
          )}
        </section>
        <footer>
          {discard ? (
            <>
              <span>Hai modifiche non salvate.</span>
              <button className="cw-secondary" onClick={() => setDiscard(false)}>
                Continua a modificare
              </button>
              <button className="cw-primary" onClick={onClose}>
                Esci senza salvare
              </button>
            </>
          ) : (
            <>
              <span role="status">
                {saved ? (
                  <>
                    <Check size={14} /> {storageStatus}
                  </>
                ) : dirty ? (
                  "Modifiche non salvate"
                ) : (
                  storageStatus
                )}
              </span>
              <button className="cw-secondary" onClick={close}>
                Chiudi
              </button>
              <button
                className="cw-primary"
                disabled={!valid || !dirty}
                onClick={() => {
                  onSave({
                    ...draft,
                    spaceName: draft.spaceName.trim(),
                    displayName: draft.displayName.trim(),
                  });
                  setSaved(true);
                  setError("");
                }}
              >
                Salva preferenze
              </button>
            </>
          )}
        </footer>
      </div>
    </dialog>
  );
}
