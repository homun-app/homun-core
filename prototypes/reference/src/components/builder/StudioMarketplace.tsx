import { StudioMemberPicker } from "./StudioMemberPicker";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  FileText,
  Globe,
  Layers3,
  Mail,
  MessageCircle,
  Plus,
  Puzzle,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";
const catalog = [
  {
    id: "web",
    name: "Ricerca web",
    category: "Ricerca",
    description: "Trova fonti e informazioni per ricerche e aggiornamenti.",
    icon: Globe,
    color: "mint",
    kind: "Base gratuita",
    access: "Ricerche sul web e consultazione delle pagine selezionate.",
    setup: "Provider di ricerca da configurare nel prodotto completo.",
  },
  {
    id: "trello",
    name: "Trello",
    category: "Lavoro",
    description: "Porta task, priorità e piani di lavoro dentro la squadra.",
    icon: Layers3,
    color: "blue",
    kind: "Base gratuita",
    access:
      "Lettura delle bacheche autorizzate. Scrittura dei task soggetta alle regole del collaboratore.",
    setup: "Account e bacheche da autorizzare.",
  },
  {
    id: "mattermost",
    name: "Mattermost",
    category: "Comunicazione",
    description: "Recupera il contesto delle conversazioni aziendali.",
    icon: MessageCircle,
    color: "lilac",
    kind: "Base gratuita",
    access: "Lettura dei canali autorizzati. Invio di messaggi solo se consentito.",
    setup: "Server e canali da collegare.",
  },
  {
    id: "wiki",
    name: "Wiki",
    category: "Conoscenza",
    description: "Rendi disponibili procedure e documentazione della tua azienda.",
    icon: BookOpen,
    color: "peach",
    kind: "Base gratuita",
    access: "Consultazione delle pagine rese disponibili al collaboratore.",
    setup: "Indirizzo della wiki e ambito di accesso da configurare.",
  },
  {
    id: "email",
    name: "Email",
    category: "Comunicazione",
    description: "Leggi richieste e prepara risposte nella tua casella di lavoro.",
    icon: Mail,
    color: "peach",
    kind: "Base gratuita",
    access:
      "Lettura della posta selezionata, creazione bozze e invio secondo le regole di autonomia.",
    setup: "Casella e cartelle da autorizzare. Nessun account collegato nella demo.",
  },
  {
    id: "calendar",
    name: "Calendario",
    category: "Lavoro",
    description: "Organizza appuntamenti e consulta le disponibilità.",
    icon: CalendarDays,
    color: "blue",
    kind: "Base gratuita",
    access: "Lettura e modifica dei calendari selezionati, secondo i permessi concessi.",
    setup: "Account e calendari da selezionare.",
  },
  {
    id: "files",
    name: "Documenti",
    category: "Conoscenza",
    description: "Usa file, listini e materiali di riferimento nei tuoi progetti.",
    icon: FileText,
    color: "mint",
    kind: "Base gratuita",
    access: "Accesso ai soli file e alle cartelle scelti per il lavoro.",
    setup: "File o cartelle da selezionare.",
  },
  {
    id: "terminal",
    name: "Terminale",
    category: "Lavoro",
    description: "Esegui controlli tecnici nell’ambiente autorizzato.",
    icon: Terminal,
    color: "lilac",
    kind: "Base gratuita",
    access: "Esecuzione di comandi nell’ambiente assegnato, con limiti e approvazioni da definire.",
    setup: "Ambiente di esecuzione da configurare. La demo non esegue comandi.",
  },
  {
    id: "invoices",
    name: "Fatturazione",
    category: "Specializzati",
    description: "Un modulo per documenti fiscali e flussi amministrativi specifici.",
    icon: FileText,
    color: "peach",
    kind: "Modulo specializzato",
    access: "Dati amministrativi e documenti esplicitamente autorizzati.",
    setup: "Proposta di modulo: disponibilità e prezzo da definire.",
  },
  {
    id: "templates",
    name: "Template di settore",
    category: "Specializzati",
    description: "Modelli di documenti e procedure pronti da adattare alla tua attività.",
    icon: Puzzle,
    color: "lilac",
    kind: "Modulo specializzato",
    access: "Materiali del progetto selezionati per la composizione dei documenti.",
    setup: "Proposta di modulo: disponibilità e prezzo da definire.",
  },
];
const categories = ["Tutti", "Comunicazione", "Lavoro", "Ricerca", "Conoscenza", "Specializzati"];
type Person = { id: string; name: string; tools: string[] };
export function StudioMarketplace({
  people,
  emptyStart = false,
  onAssign,
}: {
  emptyStart?: boolean;
  people: Person[];
  onAssign: (personId: string, tool: string, enabled: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Tutti");
  const [mode, setMode] = useState("catalog");
  const [installed, setInstalled] = useState<string[]>(
    emptyStart ? [] : ["web", "trello", "mattermost", "wiki", "files"],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const plugin = catalog.find((p) => p.id === selected);
  const visible = catalog.filter(
    (p) =>
      (category === "Tutti" || p.category === category) &&
      (mode !== "installed" || installed.includes(p.id)) &&
      `${p.name} ${p.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  );
  return (
    <>
      {plugin ? (
        <>
          <button className="st-back" onClick={() => setSelected(null)}>
            <ArrowLeft size={13} /> Tutti i plugin
          </button>
          <div className="st-plugin-header">
            <span className={`st-plugin-icon ${plugin.color}`}>
              <plugin.icon size={30} />
            </span>
            <div>
              <span className="st-eyebrow">
                {plugin.category} · {plugin.kind}
              </span>
              <h1>{plugin.name}</h1>
              <p className="st-intro">{plugin.description}</p>
            </div>
          </div>
          <div className="st-settings">
            <section className="st-paper">
              <h2>Disponibile alla tua squadra</h2>
              <p className="st-muted" style={{ marginTop: 12 }}>
                Aggiungi il plugin allo spazio, poi scegli chi può usarlo.
              </p>
              <button
                className="st-btn dark"
                style={{ marginTop: 20 }}
                disabled={installed.includes(plugin.id)}
                onClick={() => setInstalled((ids) => [...ids, plugin.id])}
              >
                {installed.includes(plugin.id) ? (
                  <>
                    <Check size={16} /> Aggiunto nella demo
                  </>
                ) : (
                  <>
                    <Plus size={16} /> Aggiungi allo spazio demo
                  </>
                )}
              </button>
              {installed.includes(plugin.id) && (
                <>
                  <h3 style={{ marginTop: 28 }}>Collaboratori abilitati</h3>
                  <StudioMemberPicker
                    multiple
                    label="Collaboratori abilitati al plugin"
                    options={people}
                    value={people.filter((p) => p.tools.includes(plugin.name)).map((p) => p.id)}
                    onChange={(ids) =>
                      people.forEach((p) => {
                        if (ids.includes(p.id) !== p.tools.includes(plugin.name))
                          onAssign(p.id, plugin.name, ids.includes(p.id));
                      })
                    }
                  />
                </>
              )}
            </section>
            <section className="st-paper">
              <h2>Accesso e configurazione</h2>
              <p className="st-plugin-description">{plugin.access}</p>
              <div className="st-soft-note">
                <ShieldCheck size={18} />
                <span>{plugin.setup}</span>
              </div>
              <p className="st-muted" style={{ marginTop: 20 }}>
                L’aggiunta e l’assegnazione sono simulate. Nessun software viene installato, nessun
                account autorizzato e nessun acquisto eseguito.
              </p>
              {plugin.kind === "Base gratuita" && (
                <p className="st-muted" style={{ marginTop: 12 }}>
                  Il plugin fa parte del core gratuito previsto. Eventuali costi del servizio
                  esterno restano separati.
                </p>
              )}
            </section>
          </div>
        </>
      ) : (
        <>
          <div className="st-section-head" style={{ marginTop: 0 }}>
            <div>
              <span className="st-eyebrow">PLUGIN / MARKETPLACE</span>
              <h1>Plugin</h1>
            </div>
            <span className="st-market-count">
              <Puzzle size={16} />
              {installed.length} aggiunti nella demo
            </span>
          </div>
          <p className="st-intro">
            Collega gli strumenti di lavoro e aggiungi competenze specializzate ai tuoi
            collaboratori.
          </p>
          <div className="st-market-toolbar">
            <div className="st-segment">
              {[
                ["catalog", "Esplora"],
                ["installed", "Aggiunti"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  aria-pressed={mode === id}
                  className={mode === id ? "active" : ""}
                  onClick={() => setMode(id!)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="st-market-search">
              <Search size={17} />
              <input
                aria-label="Cerca plugin"
                placeholder="Cerca un plugin…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className="st-market-categories">
            {categories.map((c) => (
              <button
                key={c}
                className={category === c ? "active" : ""}
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="st-plugin-grid">
            {visible.map((p) => (
              <button key={p.id} className="st-plugin-card" onClick={() => setSelected(p.id)}>
                <div className="st-plugin-card-top">
                  <span className={`st-plugin-icon ${p.color}`}>
                    <p.icon size={23} />
                  </span>
                  {installed.includes(p.id) ? (
                    <span className="st-plugin-added">
                      <Check size={12} /> Aggiunto
                    </span>
                  ) : (
                    <ArrowUpRight size={17} />
                  )}
                </div>
                <h2>{p.name}</h2>
                <p>{p.description}</p>
                <div className="st-plugin-card-bottom">
                  <span>{p.kind}</span>
                  <span>
                    {p.kind === "Modulo specializzato" ? "Concept" : "Scopri"}
                    <ArrowRightIcon />
                  </span>
                </div>
              </button>
            ))}
          </div>
          {!visible.length && (
            <div className="st-empty">
              <Search size={25} />
              <h2>Nessun plugin trovato.</h2>
              <p>Prova un altro nome o rimuovi i filtri.</p>
              <button
                className="st-btn dark"
                onClick={() => {
                  setQuery("");
                  setCategory("Tutti");
                  setMode("catalog");
                }}
              >
                Mostra tutti
              </button>
            </div>
          )}
          <p className="st-muted" style={{ marginTop: 22 }}>
            Catalogo dimostrativo. Strumenti di base gratuiti; offerta e prezzi dei moduli
            specializzati ancora da definire.
          </p>
        </>
      )}
    </>
  );
}
function ArrowRightIcon() {
  return <ArrowUpRight size={12} />;
}
