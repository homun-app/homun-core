import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  MessageSquare,
  Paperclip,
  Pencil,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Field =
  "responsibility" | "source" | "materials" | "start" | "method" | "result" | "autonomy" | "budget";
const fields: { id: Field; label: string; question: string; choices: string[] }[] = [
  {
    id: "responsibility",
    label: "Responsabilità",
    question: "Quale lavoro vorresti affidare al collaboratore?",
    choices: [],
  },
  {
    id: "source",
    label: "Da dove riceve il lavoro",
    question:
      "Da dove deve ricevere il lavoro? Puoi scegliere un punto di partenza e aggiungere dettagli.",
    choices: [
      "Da me, in chat",
      "Una casella email",
      "Una cartella",
      "Un altro bot",
      "Un servizio esterno",
    ],
  },
  {
    id: "materials",
    label: "Materiali di riferimento",
    question:
      "Quali documenti o informazioni deve usare? Puoi scegliere file oppure descrivere la fonte da collegare.",
    choices: ["Dal vault del progetto", "Una cartella da collegare", "Non servono materiali"],
  },
  {
    id: "start",
    label: "Quando parte",
    question: "Cosa deve far partire questo lavoro?",
    choices: ["Quando glielo chiedo", "Giorni e orari", "A intervalli", "Quando succede qualcosa"],
  },
  {
    id: "method",
    label: "Metodo di lavoro",
    question: "Come vuoi che lavori? Descrivi i passaggi e come deve verificare il risultato.",
    choices: [],
  },
  {
    id: "result",
    label: "Cosa consegna",
    question: "Che cosa vuoi ricevere alla fine e dove deve lasciarlo?",
    choices: ["Una bozza da rivedere", "Un documento nel progetto", "Un resoconto in chat"],
  },
  {
    id: "autonomy",
    label: "Autonomia",
    question: "Quando deve chiedere il tuo intervento?",
    choices: [
      "Prima di ogni azione esterna",
      "Quando manca qualcosa o trova un problema",
      "Prepara soltanto bozze",
    ],
  },
  {
    id: "budget",
    label: "Modelli e limite di spesa",
    question:
      "Quali modelli può usare? Per quelli remoti indica anche il limite di spesa e il periodo.",
    choices: ["Solo modelli locali", "Locali e remoti, con un limite"],
  },
];
type Message = { role: "user" | "assistant"; text: string };
type Draft = Partial<Record<Field, string>>;
export function ChatWorkJourney({
  projectName,
  storageKey,
}: {
  projectName: string;
  storageKey: string;
}) {
  const [draft, setDraft] = useState<Draft>({});
  const [active, setActive] = useState<Field | null>("responsibility");
  const [messages, setMessages] = useState<Message[]>([]);
  const [answer, setAnswer] = useState("");
  const [mode, setMode] = useState("");
  const [days, setDays] = useState<string[]>(["Lun", "Mar", "Mer", "Gio", "Ven"]);
  const [time, setTime] = useState("09:00");
  const [interval, setInterval] = useState("30");
  const [unit, setUnit] = useState("minuti");
  const [ready, setReady] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("Nuovo collaboratore");
  const bottom = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const current = fields.find((f) => f.id === active);
  const key = `${storageKey}:chat-v1`;
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (
        saved &&
        saved.draft &&
        fields.every(
          (f) => saved.draft[f.id] === undefined || typeof saved.draft[f.id] === "string",
        )
      ) {
        setDraft(saved.draft);
        setActive(fields.find((f) => !saved.draft[f.id])?.id || null);
        if (typeof saved.name === "string") setName(saved.name);
      }
    } catch {
      setStorageOk(false);
    }
    setReady(true);
  }, [key]);
  useEffect(() => {
    if (!ready) return;
    try {
      sessionStorage.setItem(key, JSON.stringify({ draft, name }));
    } catch {
      setStorageOk(false);
    }
  }, [draft, name, ready, key]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages, active]);
  function edit(id: Field) {
    setActive(id);
    setAnswer(draft[id] || "");
    setMode("");
    setNotice("");
  }
  function save(value: string) {
    if (!active || !value.trim()) return;
    const nextDraft = { ...draft, [active]: value.trim() };
    setDraft(nextDraft);
    setMessages((m) => [
      ...m,
      { role: "assistant", text: current?.question || "" },
      { role: "user", text: value.trim() },
    ]);
    const next = fields.find((f) => !nextDraft[f.id]);
    setActive(next?.id || null);
    setAnswer("");
    setMode("");
    setNotice("");
  }
  function skip() {
    const index = fields.findIndex((f) => f.id === active);
    const next = fields.slice(index + 1).find((f) => !draft[f.id]);
    setActive(next?.id || null);
    setAnswer("");
    setMode("");
  }
  function choose(value: string) {
    if (active === "start" && value !== "Quando glielo chiedo") {
      setMode(value);
      setAnswer("");
      return;
    }
    if (
      (active === "source" && value !== "Da me, in chat") ||
      (active === "materials" && value !== "Non servono materiali") ||
      (active === "budget" && value !== "Solo modelli locali")
    ) {
      setMode(value);
      setAnswer("");
      return;
    }
    save(value);
  }
  function submit() {
    if (active === "start" && mode === "Giorni e orari") {
      if (!days.length || !time) {
        setNotice("Scegli almeno un giorno e un orario.");
        return;
      }
      save(`${days.join(", ")} alle ${time} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
      return;
    }
    if (active === "start" && mode === "A intervalli") {
      if (!Number.isFinite(Number(interval)) || Number(interval) <= 0) {
        setNotice("Indica un intervallo positivo.");
        return;
      }
      save(`Ogni ${interval} ${unit}${answer.trim() ? ` · ${answer.trim()}` : ""}`);
      return;
    }
    if (!answer.trim()) {
      setNotice("Aggiungi un dettaglio oppure scegli «Definisco dopo».");
      return;
    }
    save(mode ? `${mode}: ${answer}` : answer);
  }
  const missing = fields.filter((f) => !draft[f.id]);
  return (
    <section className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Prototipo interattivo · dialogo guidato, nessuna AI o connessione attiva</span>
        <span>{projectName}</span>
      </div>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Costruiamo il tuo collaboratore</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Racconta il lavoro. Le scelte prendono forma a destra e puoi cambiarle in ogni momento.
        </p>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)]">
        <div className="min-w-0 rounded-2xl border border-border bg-card/30">
          <div className="flex items-center gap-2 border-b border-border px-5 py-4 text-sm">
            <MessageSquare className="size-4 text-accent" /> Definiamo il lavoro insieme
          </div>
          <div className="max-h-[45vh] space-y-4 overflow-y-auto px-5 py-5">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Puoi scrivere liberamente o usare le scelte proposte. In questa prova registro le tue
              risposte nel punto selezionato: non interpreto automaticamente il testo.
            </p>
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === "user"
                    ? "ml-8 whitespace-pre-wrap break-words rounded-xl bg-secondary p-3 text-sm"
                    : "mr-6 text-sm leading-relaxed"
                }
              >
                {m.text}
              </div>
            ))}
            <div ref={bottom} className="scroll-mt-3">
              {!current && (
                <p className="text-sm font-medium leading-relaxed">
                  La bozza è qui accanto. Rivedi le scelte oppure completa i punti lasciati aperti.
                </p>
              )}
            </div>
          </div>
          {current && (
            <div className="border-t border-border p-5">
              <p className="mb-4 text-sm font-medium leading-relaxed">{current.question}</p>
              <div className="mb-4 flex flex-wrap gap-2">
                {current.choices.map((choice) => (
                  <Button
                    key={choice}
                    variant={mode === choice ? "secondary" : "outline"}
                    size="sm"
                    className="h-auto whitespace-normal text-left"
                    onClick={() => choose(choice)}
                  >
                    {choice}
                  </Button>
                ))}
              </div>
              {active === "materials" && (
                <div className="mb-4">
                  <Button variant="outline" onClick={() => file.current?.click()}>
                    <Paperclip className="size-4" /> Scegli file dal computer
                  </Button>
                  <input
                    ref={file}
                    type="file"
                    multiple
                    className="sr-only"
                    aria-label="File di riferimento"
                    onChange={(e) => {
                      const names = Array.from(e.target.files || []).map(
                        (f) => `${f.name} (${Math.ceil(f.size / 1024)} KB)`,
                      );
                      if (names.length) {
                        setMode("File scelti");
                        setAnswer(names.join("\n"));
                      }
                    }}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    Solo nomi dei file nella bozza: nessun contenuto viene caricato o letto.
                  </p>
                </div>
              )}
              {mode && <p className="mb-3 text-xs font-medium text-accent">{mode}</p>}
              {mode === "Giorni e orari" && (
                <div className="mb-4 space-y-3">
                  <div className="flex flex-wrap gap-1">
                    {["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((day) => (
                      <Button
                        size="sm"
                        variant={days.includes(day) ? "secondary" : "outline"}
                        aria-pressed={days.includes(day)}
                        key={day}
                        onClick={() =>
                          setDays((d) =>
                            d.includes(day) ? d.filter((x) => x !== day) : [...d, day],
                          )
                        }
                      >
                        {day}
                      </Button>
                    ))}
                  </div>
                  <label className="block text-xs">
                    Orario
                    <Input
                      aria-label="Orario"
                      type="time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                      className="mt-2"
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Fuso: {Intl.DateTimeFormat().resolvedOptions().timeZone}
                  </p>
                </div>
              )}
              {mode === "A intervalli" && (
                <div className="mb-4 flex gap-2">
                  <Input
                    aria-label="Intervallo"
                    type="number"
                    min="1"
                    value={interval}
                    onChange={(e) => setInterval(e.target.value)}
                  />
                  <select
                    aria-label="Unità intervallo"
                    className="rounded-md border border-border bg-background px-3"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  >
                    <option>minuti</option>
                    <option>ore</option>
                    <option>giorni</option>
                  </select>
                </div>
              )}
              {mode !== "Giorni e orari" && (
                <>
                  <label htmlFor="chat-answer" className="mb-2 block text-xs text-muted-foreground">
                    {mode === "Quando succede qualcosa"
                      ? "Evento e condizioni (es. nuova email, solo nei giorni lavorativi)"
                      : mode
                        ? "Dettagli da includere nella bozza"
                        : "La tua risposta"}
                  </label>
                  <Textarea
                    id="chat-answer"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder={
                      mode === "Una casella email"
                        ? "Indirizzo, cartella e messaggi da considerare…"
                        : "Scrivi qui…"
                    }
                    className="min-h-24 resize-y"
                  />
                </>
              )}
              {mode && !["Giorni e orari", "A intervalli", "File scelti"].includes(mode) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Descriviamo la configurazione. Account, vault, cartelle e modelli non vengono
                  collegati in questa prova.
                </p>
              )}
              {notice && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {notice}
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={skip}>
                  Definisco dopo
                </Button>
                <Button onClick={submit}>
                  Aggiorna la bozza <Send className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
        <aside className="min-w-0 rounded-2xl border border-border bg-card/50 lg:sticky lg:top-5">
          <div className="border-b border-border p-5">
            <div className="mb-3 flex items-center justify-between text-xs">
              <span className="text-accent">LA TUA BOZZA</span>
              <span className="text-muted-foreground">
                {fields.length - missing.length}/{fields.length} punti definiti
              </span>
            </div>
            <label htmlFor="bot-name" className="text-xs text-muted-foreground">
              Nome del collaboratore
            </label>
            <Input
              id="bot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-2 border-transparent bg-transparent px-0 text-lg font-semibold"
            />
          </div>
          <div className="divide-y divide-border">
            {fields.map((f) => (
              <button
                key={f.id}
                onClick={() => edit(f.id)}
                className={`flex w-full items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-secondary/40 ${active === f.id ? "bg-secondary/30" : ""}`}
              >
                <span className="mt-1 text-accent">
                  {draft[f.id] ? (
                    <Check className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted-foreground">{f.label}</span>
                  <span className="mt-1 block whitespace-pre-wrap break-words text-sm">
                    {draft[f.id] || "Da definire"}
                  </span>
                </span>
                <Pencil className="mt-1 size-3 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
          <div className="border-t border-border p-5">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {missing.length
                ? "Puoi lasciare punti aperti e tornarci dalla bozza."
                : "Configurazione descritta. Collegamenti e fattibilità sono ancora da verificare."}
            </p>
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => {
                setActive(null);
                setNotice("");
                setMessages((m) => [
                  ...m,
                  {
                    role: "assistant",
                    text: missing.length
                      ? `Restano da definire: ${missing.map((f) => f.label.toLowerCase()).join(", ")}. Puoi completarli cliccando nella bozza.`
                      : "La bozza descrive il lavoro. Nel prodotto potrai verificare i collegamenti e fare una prova prima di attivarlo. Qui nessuna automazione è stata avviata.",
                  },
                ]);
              }}
            >
              Rivedi insieme <ArrowRight className="size-4" />
            </Button>
          </div>
        </aside>
      </div>
      <p role="status" className="mt-4 text-xs text-muted-foreground">
        {storageOk
          ? "Bozza conservata in questa sessione del browser. La cronologia della chat non viene conservata."
          : "Salvataggio non disponibile: mantieni aperta la pagina."}
      </p>
    </section>
  );
}
