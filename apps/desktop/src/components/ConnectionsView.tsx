import { Plus, Search, ShieldCheck } from "lucide-react";
import type { ConnectionItem } from "../types";

interface ConnectionsViewProps {
  connections: ConnectionItem[];
}

const featured = [
  {
    title: "Esegui attività complesse nel browser",
    description: "Azioni locali con profilo assistant e approval gates.",
  },
  {
    title: "Collega posta e calendario",
    description: "Provider managed solo con opt-in esplicito.",
  },
  {
    title: "Trasforma flussi in skill",
    description: "Abilità riutilizzabili, sandboxate e auditabili.",
  },
];

export function ConnectionsView({ connections }: ConnectionsViewProps) {
  return (
    <section className="connections-view" aria-labelledby="connections-title">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Plugin</p>
          <h2 id="connections-title">Connettori e skill</h2>
        </div>
        <div className="page-actions">
          <button className="secondary-button" type="button">I miei plugin</button>
          <button className="primary-button" type="button">Crea</button>
        </div>
      </header>

      <div className="feature-strip" aria-label="Plugin in evidenza">
        {featured.map((item) => (
          <article className="feature-card" key={item.title}>
            <ShieldCheck size={20} />
            <strong>{item.title}</strong>
            <small>{item.description}</small>
          </article>
        ))}
      </div>

      <label className="search-field">
        <Search size={17} />
        <input placeholder="Cerca connettori, abilità, fonti dati" />
      </label>

      <ConnectorSection
        title="Connettori"
        description="Collega app e API per condividere il tuo contesto."
        connections={connections}
      />
      <ConnectorSection
        title="Skill"
        description="Trasforma conoscenze e workflow in strumenti riutilizzabili."
        connections={connections.filter((item) => item.type === "skill")}
      />
    </section>
  );
}

function ConnectorSection({
  title,
  description,
  connections,
}: {
  title: string;
  description: string;
  connections: ConnectionItem[];
}) {
  return (
    <section className="connector-section" aria-label={title}>
      <div className="connector-section-title">
        <div>
          <h3>{title}</h3>
          <small>{description}</small>
        </div>
        <button className="subtle-button" type="button">Visualizza tutto</button>
      </div>
      <div className="connector-grid">
        {connections.map((connection) => (
          <article className="connector-row" key={`${title}-${connection.id}`}>
            <span className="connector-icon">{connection.name.slice(0, 1)}</span>
            <div>
              <strong>{connection.name}</strong>
              <small>{connection.description}</small>
            </div>
            <button className="add-button" type="button" aria-label={`Aggiungi ${connection.name}`}>
              <Plus size={16} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
