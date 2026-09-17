import { ConversationMemberPicker } from "./ConversationMemberPicker";
import { ConversationPluginCatalog } from "./ConversationPluginCatalog";
import { useState } from "react";
import { memberPluginCatalog, memberProfile, isHumanMember } from "./conversation-members";
import { spacePeople, type SpaceData } from "./ConversationSpace";
import { StudioChatInput } from "./StudioChatInput";

export function ConversationPlugins({
  onReveal,
  data,
  onChange,
}: {
  onReveal: () => void;
  data: SpaceData;
  onChange: (data: SpaceData) => void;
  onMember: (name: string) => void;
}) {
  const [catalog, setCatalog] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelectedValue] = useState("");
  function setSelected(id: string) {
    setSelectedValue(id);
    if (id) onReveal();
  }
  const [removing, setRemoving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const installed = data.installedPlugins || [];
  const people = [...new Set([...spacePeople, ...Object.keys(data.profiles || {})])].filter(
    (n) => !isHumanMember(n, data.profiles) && !data.removedPeople?.includes(n),
  );
  const plugin = memberPluginCatalog.find((p) => p.name === selected);
  const assigned = people.filter((n) => memberProfile(n, data.profiles).plugins.includes(selected));
  function toggle(name: string) {
    const profile = memberProfile(name, data.profiles);
    onChange({
      ...data,
      profiles: {
        ...data.profiles,
        [name]: {
          ...profile,
          plugins: profile.plugins.includes(selected)
            ? profile.plugins.filter((p) => p !== selected)
            : [...profile.plugins, selected],
        },
      },
    });
  }
  function remove() {
    const profiles = { ...data.profiles };
    for (const n of [...new Set([...spacePeople, ...Object.keys(data.profiles || {})])]) {
      const profile = memberProfile(n, profiles);
      profiles[n] = { ...profile, plugins: profile.plugins.filter((p) => p !== selected) };
    }
    onChange({ ...data, profiles, installedPlugins: installed.filter((p) => p !== selected) });
    setRemoving(false);
    setFeedback(`${selected} rimosso dallo spazio e dagli agenti.`);
  }
  return (
    <div className="cw-stage with-panel cs-stage">
      {catalog && (
        <ConversationPluginCatalog
          assigned={installed}
          initialQuery={catalogQuery}
          onClose={() => setCatalog(false)}
          onAdd={(name) => {
            onChange({ ...data, installedPlugins: [...new Set([...installed, name])] });
            setSelected(name);
          }}
        />
      )}
      <section className="cw-conversation">
        <div className="cw-history">
          <span className="cw-overline">PLUGIN</span>
          <h1 className="cs-title">Gli strumenti della squadra.</h1>
          <p className="cs-intro">
            Trova uno strumento, aggiungilo allo spazio e scegli chi può usarlo.
          </p>
          <div className="cs-actions">
            <button
              className="cw-primary"
              onClick={() => {
                setCatalogQuery("");
                setCatalog(true);
              }}
            >
              Aggiungi plugin
            </button>
          </div>
          <input
            className="cs-member-search"
            aria-label="Cerca plugin aggiunti"
            placeholder="Cerca per nome o attività…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!installed.length && (
            <p className="cw-hint">
              Nessun plugin aggiunto. Apri il catalogo per scegliere gli strumenti.
            </p>
          )}
          <div className="cs-collection">
            {memberPluginCatalog
              .filter((p) => installed.includes(p.name))
              .filter((p) =>
                (p.name + " " + p.description).toLowerCase().includes(query.toLowerCase()),
              )
              .map((p) => (
                <button
                  key={p.name}
                  className={selected === p.name ? "active" : ""}
                  onClick={() => {
                    setSelected(p.name);
                    setRemoving(false);
                  }}
                >
                  <span>
                    <strong>{p.name}</strong>
                    <small>{p.description}</small>
                  </span>
                  <span className="cs-badge">
                    {installed.includes(p.name) ? "Aggiunto" : "Scopri"}
                  </span>
                </button>
              ))}
          </div>
          {feedback && (
            <p role="status" className="cw-hint">
              {feedback}
            </p>
          )}
        </div>
        <div className="cw-composer">
          <StudioChatInput
            label="Cerca uno strumento con Homun"
            onSend={(text) => {
              setCatalogQuery(text);
              setCatalog(true);
            }}
          />
          <div className="cw-composer-caption">
            Catalogo dimostrativo · nessuna connessione esterna
          </div>
        </div>
      </section>
      <aside className="cw-workspace cs-panel">
        {plugin ? (
          <>
            <span className="cw-overline">STRUMENTO</span>
            <h2>{plugin.name}</h2>
            <p>{plugin.description}</p>
            {!installed.includes(selected) ? (
              <button
                className="cw-primary"
                onClick={() => onChange({ ...data, installedPlugins: [...installed, selected] })}
              >
                Aggiungi allo spazio
              </button>
            ) : (
              <>
                <span className="cs-badge">Aggiunto · non connesso</span>
                <h3>Agenti abilitati</h3>
                <p className="cw-hint">L’assegnazione è condivisa con la scheda dell’agente.</p>
                <ConversationMemberPicker
                  people={people}
                  profiles={data.profiles}
                  selected={assigned}
                  onChange={(names) => {
                    const changed = people.find((n) => assigned.includes(n) !== names.includes(n));
                    if (changed) toggle(changed);
                  }}
                />
                <p className="cw-hint">
                  La connessione all’account e i permessi sui dati saranno configurati con il
                  motore. Aggiungere il plugin non autorizza azioni esterne.
                </p>
                <div className="cs-management">
                  {removing ? (
                    <>
                      <h3>Rimuovere {selected}?</h3>
                      <p className="cw-hint">
                        Verrà scollegato da {assigned.length} agenti. Le conversazioni esistenti
                        restano disponibili.
                      </p>
                      <div className="cs-actions">
                        <button className="cs-link" onClick={() => setRemoving(false)}>
                          Annulla
                        </button>
                        <button className="cw-primary" onClick={remove}>
                          Conferma rimozione
                        </button>
                      </div>
                    </>
                  ) : (
                    <button className="cs-link" onClick={() => setRemoving(true)}>
                      Rimuovi dallo spazio
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <h2>Collega ciò che usi già.</h2>
            <p className="cw-hint">
              Seleziona un plugin per vedere i dettagli e assegnarlo agli agenti.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
