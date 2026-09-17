import { useState } from "react";
import { StudioChatInput } from "./StudioChatInput";
import type { MemberProfile } from "./conversation-members";
export function ConversationCreateMember({
  names,
  emails,
  onCreate,
  onReveal,
  initial,
}: {
  names: string[];
  emails: string[];
  onCreate: (name: string, profile: MemberProfile) => void;
  onReveal: () => void;
  initial: string;
}) {
  const [human, setHuman] = useState(false);
  const [email, setEmail] = useState("");
  const [description, setDescription] = useState(initial);
  const [name, setName] = useState("");
  const [role, setRole] = useState("Collaboratore AI");
  const [tone, setTone] = useState("Chiaro e sintetico");
  const [skills, setSkills] = useState("");
  const duplicateEmail =
    human && emails.some((e) => e.toLowerCase() === email.trim().toLowerCase());
  const duplicate = names.some((n) => n.toLowerCase() === name.trim().toLowerCase());
  return (
    <div className="cw-stage with-panel cs-stage">
      <section className="cw-conversation">
        <div className="cw-history">
          <span className="cw-overline">NUOVO COLLABORATORE</span>
          <h1 className="cs-title">Chi ti serve nella squadra?</h1>
          <p className="cs-intro">Descrivi le responsabilità e come vorresti lavorare insieme.</p>
          <div className="cs-actions" role="group" aria-label="Tipo di collaboratore">
            <button
              className={human ? "cw-secondary" : "cw-primary"}
              aria-pressed={!human}
              onClick={() => {
                setHuman(false);
                setRole("Collaboratore AI");
                onReveal();
              }}
            >
              Agente AI
            </button>
            <button
              className={human ? "cw-primary" : "cw-secondary"}
              aria-pressed={human}
              onClick={() => {
                setHuman(true);
                setRole("Collaboratore");
                onReveal();
              }}
            >
              Invita una persona
            </button>
          </div>
          {human && (
            <p className="cw-hint">
              Prepara l’invito al tuo collega. Nella demo potrai simularne l’accettazione; nessuna
              email verrà inviata.
            </p>
          )}
          {description ? (
            <>
              <article className="cw-message you">
                <small>Tu</small>
                <p>{description}</p>
              </article>
              <article className="cw-message agent">
                <small>Homun</small>
                <p>
                  Conservo questa descrizione nel curriculum. Scegli un nome e controlla la scheda a
                  destra, poi potrai affidargli il primo incarico.
                </p>
                <small>
                  Proposta manualmente modificabile: nessun modello sta interpretando la richiesta.
                </small>
              </article>
            </>
          ) : !human ? (
            <button
              className="cs-example"
              onClick={() => {
                setDescription(
                  "Mi serve un assistente che confronti le offerte dei fornitori, evidenzi le differenze e prepari un riepilogo prima che io decida.",
                );
                setName("Nora");
                setRole("Acquisti e fornitori");
                setSkills("Confronto offerte, Sintesi, Analisi dei costi");
                onReveal();
              }}
            >
              Prova: un assistente per gli acquisti ↗
            </button>
          ) : null}
        </div>
        <div className="cw-composer">
          <StudioChatInput
            label="Descrivi il collaboratore"
            onSend={(text) => {
              if (!text.trim()) return;
              setDescription(text);
              onReveal();
            }}
          />
          <div className="cw-composer-caption">
            Descrivi liberamente il ruolo · creazione locale
          </div>
        </div>
      </section>
      <aside className="cw-workspace cs-panel">
        <span className="cs-badge">
          {human ? "Persona · invito simulato" : "Agente AI · supervisione iniziale"}
        </span>
        <h2>La sua scheda</h2>
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {human && (
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
        {duplicate && <p role="alert">Questo nome è già utilizzato.</p>}
        {duplicateEmail && (
          <p role="alert">Questa email appartiene già a un membro o a un invito.</p>
        )}
        <label>
          Ruolo
          <input value={role} onChange={(e) => setRole(e.target.value)} />
        </label>
        <label>
          Specializzazioni
          <input
            placeholder="Separate da virgole"
            value={skills}
            onChange={(e) => setSkills(e.target.value)}
          />
        </label>
        {!human && (
          <label>
            Come comunica
            <input value={tone} onChange={(e) => setTone(e.target.value)} />
          </label>
        )}
        <p className="cw-hint">
          {human
            ? "Dopo l’accettazione potrai includere la persona nei team. L’accesso ai dati non è ancora applicato dal prototipo."
            : "Parte senza strumenti assegnati. Potrai collegarli dalla scheda e verificare i suoi risultati prima di usarli."}
        </p>
        <button
          className="cw-primary"
          disabled={
            !name.trim() ||
            !role.trim() ||
            (!human && !description.trim()) ||
            (human && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) ||
            duplicate ||
            duplicateEmail
          }
          onClick={() =>
            onCreate(name.trim(), {
              kind: human ? "human" : "agent",
              ...(human ? { email: email.trim(), invitation: "pending" as const } : {}),
              role: role.trim(),
              bio: description,
              skills: skills
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              tone,
              plugins: [],
            })
          }
        >
          {human ? "Prepara invito demo" : "Crea collaboratore"}
        </button>
      </aside>
    </div>
  );
}
