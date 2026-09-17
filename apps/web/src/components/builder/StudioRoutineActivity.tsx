import type { AssignedWork } from "./StudioToday";
import { StudioChatInput } from "./StudioChatInput";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, X } from "lucide-react";
export type DemoRoutine = {
  id: string;
  name: string;
  agent: string;
  schedule: string;
  source: string;
  scope: string;
  active: boolean;
};
type DemoRun = {
  id: string;
  routineId: string;
  created: string;
  read: boolean;
  reviewed: boolean;
  title: string;
  body: string;
  conversation?: string[];
  draft?: string;
  moved?: boolean;
};
type Store = {
  routines: DemoRoutine[];
  runs: DemoRun[];
  selected: string | null;
  setSelected: (id: string | null) => void;
  register: (r: DemoRoutine) => void;
  toggle: (id: string) => void;
  simulate: (id: string) => void;
  read: (id: string) => void;
  review: (id: string) => void;
  update: (id: string, patch: Partial<DemoRun>) => void;
};
const Context = createContext<Store | null>(null);
export function useRoutineActivity() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing routine activity provider");
  return value;
}
export function StudioRoutineProvider({ children }: { children: ReactNode }) {
  const [routines, setRoutines] = useState<DemoRoutine[]>([]);
  const [runs, setRuns] = useState<DemoRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Context.Provider
      value={{
        update: (id, patch) =>
          setRuns((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r))),
        routines,
        runs,
        selected,
        setSelected,
        register: (r) => setRoutines((all) => [...all.filter((x) => x.id !== r.id), r]),
        toggle: (id) =>
          setRoutines((all) => all.map((r) => (r.id === id ? { ...r, active: !r.active } : r))),
        simulate: (id) => {
          const routine = routines.find((r) => r.id === id);
          if (!routine?.active) return;
          setRuns((all) => [
            {
              id: crypto.randomUUID(),
              routineId: id,
              created: new Date().toLocaleString("it-IT"),
              read: false,
              reviewed: false,
              title: routine.name,
              body: `${routine.agent} · ${routine.source} · ${routine.scope}. ${id === "email-demo" ? "Esempio: Rossi richiede un preventivo entro domani. Fonte: email dimostrativa della casella selezionata." : "Esempio: un task è bloccato dal materiale atteso da Giulia. Fonte: scheda Trello dimostrativa; nessun sollecito inviato."}`,
            },
            ...all,
          ]);
        },
        read: (id) => setRuns((all) => all.map((r) => (r.id === id ? { ...r, read: true } : r))),
        review: (id) =>
          setRuns((all) =>
            all.map((r) => (r.id === id ? { ...r, read: true, reviewed: true } : r)),
          ),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function StudioRoutineList({ dashboard = false }: { dashboard?: boolean }) {
  const store = useRoutineActivity();
  if (!store.routines.length) return null;
  return (
    <section
      className="st-routine-list"
      aria-label={dashboard ? "Lavoro delle automazioni" : "Routine delle simulazioni"}
    >
      <h2>{dashboard ? "Risultati delle automazioni" : "Le tue routine simulate"}</h2>
      {dashboard ? (
        <>
          {!store.runs.length && <p className="st-muted">Nessun risultato ancora.</p>}
          {store.runs.slice(0, 5).map((run) => (
            <button
              key={run.id}
              className="st-recent st-activity-row"
              onClick={() => {
                store.read(run.id);
                store.setSelected(`run:${run.id}`);
              }}
            >
              <span>
                <strong>{run.title}</strong>
                <small>
                  {store.routines.find((r) => r.id === run.routineId)?.agent} · Risultato
                  disponibile
                </small>
                <small>
                  {run.reviewed ? "Verificato" : "Da verificare"} · {run.created}
                </small>
              </span>
              <span className="st-activity-open">Apri risultato →</span>
            </button>
          ))}
        </>
      ) : (
        store.routines.map((r) => (
          <button
            key={r.id}
            className="st-recent st-activity-row"
            onClick={() => store.setSelected(r.id)}
          >
            <span>
              <strong>{r.name}</strong>
              <small>
                {r.agent} · {r.active ? "Attiva nella demo" : "In pausa"} · {r.schedule}
              </small>
            </span>
            <span>Apri automazione →</span>
          </button>
        ))
      )}
    </section>
  );
}
export function StudioActivityHub({
  tasks = [],
  onTask,
}: {
  tasks?: AssignedWork[];
  onTask?: (id: string) => void;
}) {
  const pending = tasks.filter(
    (t) => t.requestFor && t.person === "user:fabio" && t.status !== "done",
  );
  const store = useRoutineActivity();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const visible = !store.selected?.startsWith("run:") && (open || store.selected !== null);
  useEffect(() => {
    if (visible) dialog.current?.showModal();
    else dialog.current?.close();
  }, [visible]);
  useEffect(() => {
    if (store.selected?.startsWith("run:")) setOpen(false);
  }, [store.selected]);
  const unread = store.runs.filter((r) => !r.read).length + pending.length;
  const run = store.selected?.startsWith("run:")
    ? store.runs.find((r) => r.id === store.selected?.slice(4))
    : undefined;
  const routine = store.routines.find((r) => r.id === (run?.routineId || store.selected));
  const close = () => {
    setOpen(false);
    store.setSelected(null);
  };
  return (
    <>
      <button
        className="st-icon st-activity-trigger"
        aria-label={`Attività${unread ? ` · ${unread} da gestire` : ""}`}
        title="Attività"
        onClick={() => {
          store.setSelected(null);
          setOpen(true);
        }}
      >
        <Bell size={18} />
        {unread > 0 && <span className="st-activity-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      <dialog
        ref={dialog}
        className="st-activity-dialog"
        onCancel={close}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        aria-label={
          run ? "Risultato automazione" : routine ? "Dettaglio automazione" : "Centro attività"
        }
      >
        <header>
          <h2>
            {run
              ? run.reviewed
                ? "Risultato verificato"
                : "Risultato da verificare"
              : routine
                ? routine.name
                : "Attività"}
          </h2>
          <button className="st-icon" aria-label="Chiudi attività" onClick={close}>
            <X size={18} />
          </button>
        </header>
        {run && routine ? (
          <>
            <p>
              {run.created} · {routine.agent} · {run.reviewed ? "Verificato" : "Da verificare"}
            </p>
            <h3>{run.title}</h3>
            <p>{run.body}</p>
            <p className="st-muted">
              Risultato e fonti fittizi. Verificare il risultato non autorizza invii o modifiche
              esterne.
            </p>
            <div className="st-sim-actions">
              <button className="st-btn" onClick={() => store.setSelected(routine.id)}>
                Apri automazione
              </button>
              <button
                className="st-btn dark"
                disabled={run.reviewed}
                onClick={() => store.review(run.id)}
              >
                {run.reviewed ? "Verificato" : "Segna come verificato"}
              </button>
            </div>
          </>
        ) : routine ? (
          <>
            <p>
              {routine.agent} · {routine.active ? "Attiva nella simulazione" : "In pausa"}
            </p>
            <p>
              <strong>Quando:</strong> {routine.schedule}
            </p>
            <p>
              <strong>Fonte:</strong> {routine.source}
            </p>
            <p>
              <strong>Risultato:</strong> {routine.scope}
            </p>
            <p>
              In stage · ogni risultato richiede verifica. Costo reale: non disponibile, nessun
              modello collegato.
            </p>
            <p className="st-muted">
              Prossimo avvio: simulato su richiesta. Nessuna pianificazione reale.
            </p>
            <div className="st-sim-actions">
              <button className="st-btn" onClick={() => store.toggle(routine.id)}>
                {routine.active ? "Metti in pausa" : "Riprendi nella demo"}
              </button>
              <button
                className="st-btn dark"
                disabled={!routine.active}
                onClick={() => store.simulate(routine.id)}
              >
                Simula risultato in arrivo
              </button>
            </div>
            <h3>Esecuzioni</h3>
            {!store.runs.some((r) => r.routineId === routine.id) && (
              <p>Nessuna esecuzione simulata.</p>
            )}
            {store.runs
              .filter((r) => r.routineId === routine.id)
              .map((r) => (
                <button
                  className="st-recent st-activity-row"
                  key={r.id}
                  onClick={() => {
                    store.read(r.id);
                    store.setSelected(`run:${r.id}`);
                  }}
                >
                  <span>
                    {r.created}
                    <small>{r.reviewed ? "Verificato" : "Da verificare"}</small>
                  </span>
                  <span className="st-activity-open">Apri risultato →</span>
                </button>
              ))}
          </>
        ) : (
          <>
            <p>Risultati e richieste di verifica, senza interrompere la chat.</p>
            {pending.map((t) => (
              <button
                key={t.id}
                className="st-recent st-activity-row"
                onClick={() => {
                  close();
                  onTask?.(t.id);
                }}
              >
                <span>
                  <strong>{t.title}</strong>
                  <small>Richiesto a te · il lavoro aspetta la tua risposta</small>
                </span>
                <span>Fornisci contributo →</span>
              </button>
            ))}
            {!pending.length && !store.runs.length && (
              <p className="st-muted">Nessuna nuova attività.</p>
            )}
            {store.runs.map((r) => (
              <button
                className="st-recent st-activity-row"
                key={r.id}
                onClick={() => {
                  store.read(r.id);
                  store.setSelected(`run:${r.id}`);
                }}
              >
                <span>
                  <strong>
                    {!r.read ? "● " : ""}
                    {r.title}
                  </strong>
                  <small>
                    {r.reviewed ? "Verificato" : "Da verificare"} · {r.created}
                  </small>
                </span>
                <span className="st-activity-open">Apri risultato →</span>
              </button>
            ))}
          </>
        )}
        <footer>Demo locale · dati conservati fino al ricaricamento</footer>
      </dialog>
    </>
  );
}

export function StudioResultWorkspace({
  children,
  viewKey,
}: {
  children: ReactNode;
  viewKey: string;
}) {
  const store = useRoutineActivity();
  const previous = useRef(viewKey);
  useEffect(() => {
    if (previous.current !== viewKey) {
      previous.current = viewKey;
      store.setSelected(null);
    }
  }, [viewKey, store]);
  const run = store.selected?.startsWith("run:")
    ? store.runs.find((r) => r.id === store.selected?.slice(4))
    : undefined;
  return (
    <>
      <div hidden={!!run}>{children}</div>
      {run && <StudioRunPage key={run.id} run={run} />}
    </>
  );
}
function StudioRunPage({ run }: { run: DemoRun }) {
  const store = useRoutineActivity();
  const [proposal, setProposal] = useState(false);
  const email = run.routineId === "email-demo";
  const routine = store.routines.find((r) => r.id === run.routineId);
  const say = (text: string) =>
    store.update(run.id, { conversation: [...(run.conversation || []), text] });
  function act(text: string, files: File[] = []) {
    if (files.length) {
      say("Gli allegati non sono analizzati in questa simulazione.");
      return;
    }
    if (email && /rispost|rispondi/i.test(text)) {
      store.update(run.id, {
        draft:
          "Buongiorno, abbiamo ricevuto la richiesta di preventivo. Verifichiamo i dettagli e vi aggiorniamo appena possibile. Grazie.",
        conversation: [
          ...(run.conversation || []),
          `Tu: ${text}`,
          "Vera: ho preparato una bozza modificabile qui sotto. Non è stata inviata.",
        ],
      });
    } else if (
      !email &&
      /sposta/i.test(text) &&
      /lavorazione/i.test(text) &&
      /giulia/i.test(text)
    ) {
      say(`Tu: ${text}`);
      setProposal(true);
    } else
      say(
        `Tu: ${text}\n${email ? "Vera: questa prova consente di preparare una risposta all’email. Scrivi ‘Prepara una risposta’." : "Elio: prova ‘Sposta il task in lavorazione e assegnalo a Giulia’."} Le altre richieste richiedono il motore.`,
      );
  }
  return (
    <section className="st-result-page" aria-label="Pagina del risultato">
      <header>
        <button className="st-text-link" onClick={() => store.setSelected(null)}>
          ← Torna alla vista precedente
        </button>
        <button className="st-text-link" onClick={() => store.setSelected(run.routineId)}>
          Automazione di origine →
        </button>
      </header>
      <small>
        {routine?.agent} · {run.created} · {run.reviewed ? "Verificato" : "Da verificare"}
      </small>
      <h1>{run.title}</h1>
      <article className="st-simple-result">
        <h2>{email ? "Richiesta da seguire" : "Task da sbloccare"}</h2>
        <p>{run.body}</p>
        <details>
          <summary>Apri fonte · esempio</summary>
          <p>
            {email
              ? "Email dimostrativa: «Buongiorno, potete inviarci il preventivo aggiornato entro domani? Grazie, Rossi.»"
              : "Scheda Trello dimostrativa: «Materiale mancante, serve il contributo di Giulia prima di procedere»."}
          </p>
        </details>
        {run.moved && (
          <p role="status">Scheda simulata: In lavorazione · Giulia. Dipendenza ancora aperta.</p>
        )}
      </article>
      <div className="st-sim-actions">
        <button className="st-btn" disabled={run.reviewed} onClick={() => store.review(run.id)}>
          {run.reviewed ? "Risultato verificato" : "Segna come verificato"}
        </button>
      </div>
      <h2>Continua da questo risultato</h2>
      <p className="st-muted">
        La conversazione riguarda questa esecuzione. Nessuna modifica alla routine e nessuna azione
        esterna.
      </p>
      {(run.conversation || []).map((text, i) => (
        <p className="st-result-message" key={i}>
          {text}
        </p>
      ))}
      {run.draft !== undefined && (
        <article className="st-simple-result">
          <label>
            Bozza di risposta · non inviata
            <textarea
              aria-label="Bozza della risposta"
              value={run.draft}
              onChange={(e) => store.update(run.id, { draft: e.target.value })}
            />
          </label>
          <small>
            Modifiche conservate nella sessione di questa esecuzione. L’invio non è disponibile
            nella demo.
          </small>
        </article>
      )}
      {proposal && (
        <article className="st-simple-choice">
          <p>Scheda di questa esecuzione: Da fare → In lavorazione · Giulia</p>
          <div className="st-sim-actions">
            <button className="st-btn" onClick={() => setProposal(false)}>
              Annulla
            </button>
            <button
              className="st-btn dark"
              onClick={() => {
                store.update(run.id, {
                  moved: true,
                  conversation: [
                    ...(run.conversation || []),
                    "Elio: scheda aggiornata nella simulazione. Nessuna modifica su Trello.",
                  ],
                });
                setProposal(false);
              }}
            >
              Conferma modifica simulata
            </button>
          </div>
        </article>
      )}
      {!run.draft && !run.moved && !proposal && (
        <button
          className="st-text-link"
          onClick={() =>
            act(
              email ? "Prepara una risposta" : "Sposta il task in lavorazione e assegnalo a Giulia",
            )
          }
        >
          {email
            ? "Prepara una risposta all’email"
            : "Sposta il task in lavorazione e assegnalo a Giulia"}{" "}
          →
        </button>
      )}
      <StudioChatInput label="Rispondi sul risultato" onSend={act} />
      <small className="st-muted">
        Contenuti dimostrativi. Conversazione conservata per questa esecuzione fino al
        ricaricamento.
      </small>
    </section>
  );
}
