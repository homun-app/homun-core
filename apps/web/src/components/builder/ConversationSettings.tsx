import { useEffect, useRef, useState } from "react";
import {
  X,
  Settings2,
  UserRound,
  Bell,
  Brain,
  Database,
  HelpCircle,
  Archive,
  Check,
  ArrowUpRight,
  BookMarked,
  Bot,
  Sparkles,
  FolderKanban,
  UsersRound,
  Wallet,
  Puzzle,
  Zap,
} from "lucide-react";
import { ConversationSelect } from "./ConversationSelect";
import {
  ConversationModelsSettingsSection,
  ConversationBudgetSettingsSection,
} from "./ConversationModelsSettingsSection";
import { ConversationPeopleSettingsSection } from "./ConversationPeopleSettingsSection";
import { ConversationCapabilitiesSettingsSection } from "./ConversationCapabilitiesSettingsSection";
import { ConversationMcpSettingsSection, ConversationSkillsSettingsSection } from "./EngineMcpSettings";
import { ConversationAutomationsSettingsSection } from "./ConversationAutomationsSettingsSection";
import { ConversationMemorySettingsSection } from "./ConversationMemorySettingsSection";
import { ConversationAgentsSettingsSection } from "./ConversationAgentsSettingsSection";
import { ConversationProjectsSettingsSection } from "./ConversationProjectsSettingsSection";
import { type ConversationPreferences } from "./conversation-preferences";
import "./conversation-settings.css";
const sections = [
  { id: "space", label: "Spazio e profilo", icon: UserRound },
  { id: "people", label: "Persone e accessi", icon: UsersRound },
  { id: "preferences", label: "Preferenze", icon: Settings2 },
  { id: "notifications", label: "Notifiche", icon: Bell },
  { id: "models", label: "Modelli", icon: Brain },
  { id: "budget", label: "Budget e routing", icon: Wallet },
  { id: "agents", label: "Agenti", icon: Bot },
  { id: "projects", label: "Progetti", icon: FolderKanban },
  { id: "memory", label: "Memoria", icon: BookMarked },
  { id: "plugins", label: "Plugin e capacità", icon: Puzzle },
  { id: "skills", label: "Skill", icon: Sparkles },
  { id: "automations", label: "Automazioni", icon: Zap },
  { id: "archive", label: "Archivio", icon: Archive },
  { id: "data", label: "Dati della demo", icon: Database },
  { id: "help", label: "Guida", icon: HelpCircle },
];
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
}: {
  value: ConversationPreferences;
  onSave: (p: ConversationPreferences) => void;
  onClose: () => void;
  onNavigate: (page: "Squadra" | "Plugin" | "Materiali") => void;
  onExport: () => void;
  onReset: () => Promise<void>;
  onRestore: (id: string) => void;
  archived: { id: string; title: string }[];
  storageStatus: string;
  counts: { works: number; projects: number; materials: number | null };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState("space");
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
  function change<K extends keyof ConversationPreferences>(key: K, v: ConversationPreferences[K]) {
    setDraft((p) => ({ ...p, [key]: v }));
    setSaved(false);
  }
  function close() {
    if (dirty) setDiscard(true);
    else onClose();
  }
  function navigate(page: "Squadra" | "Plugin" | "Materiali") {
    if (dirty) {
      setError("Salva o annulla le modifiche prima di aprire un’altra sezione.");
      return;
    }
    onNavigate(page);
  }
  const valid =
    draft.spaceName.trim() &&
    draft.displayName.trim() &&
    Number.isFinite(draft.budget) &&
    draft.budget >= 0 &&
    draft.perWorkBudget >= 0 &&
    draft.perWorkBudget <= draft.budget;
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
        <header>
          <div>
            <small>HOMUN · PROTOTIPO</small>
            <h2>Impostazioni</h2>
          </div>
          <button aria-label="Chiudi impostazioni" className="cw-icon" onClick={close}>
            <X size={20} />
          </button>
        </header>
        <nav aria-label="Categorie impostazioni">
          {sections.map((s) => (
            <button
              key={s.id}
              aria-current={section === s.id ? "page" : undefined}
              onClick={() => {
                setSection(s.id);
                setError("");
                setDiscard(false);
              }}
            >
              <s.icon size={17} />
              {s.label}
            </button>
          ))}
        </nav>
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
                <small>L’identità demo di riferimento rimane Fabio.</small>
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
          {section === "notifications" && (
            <>
              <h3>Solo ciò che ti serve</h3>
              <p>
                Le notifiche sono dentro lo spazio. Nessuna email o notifica di sistema viene
                inviata.
              </p>
              <div className="cv-settings-card">
                <strong>Richieste e approvazioni</strong>
                <p>Restano sempre visibili per non perdere il lavoro che aspetta te.</p>
              </div>
              <label className="cv-settings-toggle">
                <span>
                  <strong>Risultati conclusi</strong>
                  <small>Mostra nel centro notifiche anche le consegne già approvate.</small>
                </span>
                <input
                  aria-label="Notifiche risultati conclusi"
                  type="checkbox"
                  checked={draft.resultNotifications}
                  onChange={(e) => change("resultNotifications", e.target.checked)}
                />
              </label>
            </>
          )}
          {section === "models" && (
            <ConversationModelsSettingsSection draft={draft} onChange={change} />
          )}
          {section === "budget" && (
            <ConversationBudgetSettingsSection draft={draft} onChange={change} />
          )}
          {section === "people" && <ConversationPeopleSettingsSection />}
          {section === "plugins" && <ConversationCapabilitiesSettingsSection />}
          {section === "automations" && <ConversationAutomationsSettingsSection />}
          {section === "skills" && <ConversationSkillsSettingsSection />}
          {section === "agents" && <ConversationAgentsSettingsSection actorId="person_fabio" />}
          {section === "projects" && (
            <ConversationProjectsSettingsSection actorId="person_fabio" />
          )}
          {section === "memory" && (
            <ConversationMemorySettingsSection actorId="person_fabio" />
          )}
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
          {section === "data" && (
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
                <a href="http://127.0.0.1:4182/prototypes/first-work.html">Versione precedente ↗</a>
              </div>
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
