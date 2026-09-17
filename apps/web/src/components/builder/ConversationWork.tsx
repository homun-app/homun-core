import { useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  FileText,
  Mail,
  Paperclip,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Button } from "@homun/ui/components/button";
import { Input } from "@homun/ui/components/input";
import { WORK_EXAMPLES, type Example } from "@/lib/assisted-work";

type Stage = "welcome" | "materials" | "result" | "connect" | "schedule" | "saved";
type Entry = { role: "user" | "bot"; text: string };
export function ConversationWork({ projectName }: { projectName: string; storageKey: string }) {
  const [stage, setStage] = useState<Stage>("welcome");
  const [example, setExample] = useState<Example | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [details, setDetails] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [sample, setSample] = useState(false);
  const [connected, setConnected] = useState(false);
  const [routine, setRoutine] = useState("");
  const [trigger, setTrigger] = useState("event");
  const [days, setDays] = useState<string[]>(["Lun", "Mar", "Mer", "Gio", "Ven"]);
  const [time, setTime] = useState("09:00");
  const [interval, setInterval] = useState("30");
  const [event, setEvent] = useState("Nuovo messaggio nella cartella Richieste");
  const [error, setError] = useState("");
  const [name, setName] = useState("Il tuo collaboratore");
  const upload = useRef<HTMLInputElement>(null);
  const current = useRef<HTMLDivElement>(null);
  function scroll() {
    requestAnimationFrame(() =>
      current.current?.scrollIntoView({ behavior: "instant", block: "nearest" }),
    );
  }
  function say(user: string, bot?: string) {
    setEntries((previous) => [
      ...previous,
      { role: "user", text: user },
      ...(bot ? [{ role: "bot" as const, text: bot }] : []),
    ]);
    scroll();
  }
  function pick(item: Example) {
    setExample(item);
    setRoutine("");
    setFiles([]);
    setSample(false);
    say(`Proviamo: ${item.label.toLowerCase()}.`, `Partiamo da un caso fittizio. ${item.request}`);
    setStage("materials");
  }
  function showSample() {
    if (!example) return;
    setSample(true);
    setFiles([]);
    say("Usa i materiali dimostrativi.", example.reference);
    setStage("result");
  }
  function startRoutine() {
    if (stage === "result" && example && sample) {
      setEntries((previous) => [
        ...previous,
        { role: "bot", text: `Risultato illustrativo: ${example.result}` },
      ]);
    }
    say("Vorrei rendere ricorrente questo lavoro.");
    setStage("connect");
  }
  function saveRoutine() {
    if (trigger === "time" && (!days.length || !time)) {
      setError("Scegli almeno un giorno e un orario.");
      return;
    }
    if (trigger === "interval" && (!Number.isFinite(Number(interval)) || Number(interval) <= 0)) {
      setError("Indica un intervallo positivo.");
      return;
    }
    if (trigger === "event" && !event.trim()) {
      setError("Descrivi l’evento che avvia il lavoro.");
      return;
    }
    const value =
      trigger === "event"
        ? event.trim()
        : trigger === "interval"
          ? `Ogni ${interval} minuti`
          : `${days.join(", ")} alle ${time} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    setRoutine(value);
    setError("");
    say(value);
    setStage("saved");
  }
  function send() {
    if (!text.trim()) return;
    say(
      text.trim(),
      "Ho conservato la tua indicazione qui nella conversazione. Questa prova non interpreta il testo: usa le scelte del messaggio per esplorare il percorso.",
    );
    setText("");
  }
  const choice = (label: string, action: () => void) => (
    <button
      key={label}
      onClick={action}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-3 text-left text-sm transition-colors hover:bg-secondary"
    >
      <span>{label}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card/20">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
            <Bot className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">{name}</h1>
            <p className="text-xs text-muted-foreground">{projectName}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
        >
          <SlidersHorizontal className="size-4" /> Dettagli
        </Button>
      </header>
      <div className={`grid ${details ? "lg:grid-cols-[minmax(0,1fr)_290px]" : "grid-cols-1"}`}>
        <div className="min-w-0">
          <div className="h-[min(65vh,640px)] min-h-80 overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-2xl space-y-4">
              <p className="text-center text-[11px] text-muted-foreground">
                Prova UX · esempi e connessioni simulati
              </p>
              <div className="max-w-xl rounded-2xl bg-secondary/60 p-4 text-sm leading-relaxed">
                Cosa posso toglierti dalle spalle? Possiamo partire da un lavoro, usare i materiali
                che servono e poi decidere se ripeterlo.
              </div>
              {entries.map((entry, index) => (
                <div
                  key={index}
                  className={
                    entry.role === "user"
                      ? "ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-accent/15 p-3 text-sm"
                      : "max-w-xl whitespace-pre-wrap break-words rounded-2xl bg-secondary/60 p-4 text-sm leading-relaxed"
                  }
                >
                  {entry.role === "user" && <Check className="mb-1 size-3 text-accent" />}
                  {entry.text}
                </div>
              ))}
              <div ref={current} className="space-y-3 rounded-2xl bg-secondary/40 p-4">
                {stage === "welcome" && (
                  <>
                    <p className="text-sm">
                      Scegli un esempio per provare l’interazione. Il collaboratore può occuparsi di
                      qualsiasi lavoro.
                    </p>
                    {WORK_EXAMPLES.map((item) => choice(item.label, () => pick(item)))}
                    {choice("Voglio impostare subito una routine", startRoutine)}
                  </>
                )}
                {stage === "materials" && example && (
                  <>
                    <p className="text-sm leading-relaxed">
                      Per procedere mi serve:{" "}
                      <strong>{example.referenceLabel.toLowerCase()}</strong>.
                    </p>
                    {choice("Usa i materiali dimostrativi", showSample)}
                    {choice("Scegli file dal computer", () => upload.current?.click())}
                    <input
                      ref={upload}
                      className="sr-only"
                      type="file"
                      multiple
                      aria-label="Materiali del lavoro"
                      onChange={(e) => {
                        const selected = Array.from(e.target.files || []).map((f) => f.name);
                        if (selected.length) {
                          setFiles(selected);
                          setSample(false);
                          say(
                            `File scelti: ${selected.join(", ")}`,
                            "I file sono selezionati, ma questa demo non ne legge né carica il contenuto. Puoi continuare con i materiali dimostrativi per vedere un risultato illustrativo.",
                          );
                        }
                      }}
                    />
                    {files.length > 0 && (
                      <p className="break-words text-xs text-muted-foreground">
                        Selezionati: {files.join(", ")}
                      </p>
                    )}
                  </>
                )}
                {stage === "result" && example && sample && (
                  <>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Risultato illustrativo · materiali dimostrativi
                    </p>
                    <h2 className="font-medium">{example.resultTitle}</h2>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{example.result}</p>
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">Materiali e metodo</summary>
                      <p className="mt-3">{example.reference}</p>
                      <p className="mt-3 whitespace-pre-wrap">{example.method}</p>
                    </details>
                    {choice("Vorrei che lo facesse regolarmente", startRoutine)}
                    {choice("Cambiamo i materiali", () => {
                      setStage("materials");
                      scroll();
                    })}
                    {choice("Per ora basta così", () => {
                      say(
                        "Per ora basta così.",
                        "La prova finisce qui. Puoi tornare al risultato dai dettagli oppure iniziare un altro esempio.",
                      );
                      setStage("welcome");
                    })}
                  </>
                )}
                {stage === "connect" && (
                  <>
                    <p className="text-sm leading-relaxed">
                      Da dove arriverà il lavoro? Proviamo il collegamento di una casella email,
                      oppure definiamo un’altra fonte.
                    </p>
                    <div className="flex items-center gap-3 rounded-xl border border-border bg-background/50 p-3">
                      <Mail className="size-6 text-accent" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">Casella email di esempio</p>
                        <p className="text-xs text-muted-foreground">
                          Cartella Richieste · nessun account reale
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setConnected(true);
                          say(
                            "Usa la casella dimostrativa.",
                            "Collegamento simulato pronto. Scegliamo quando avviare il lavoro.",
                          );
                          setStage("schedule");
                        }}
                      >
                        Prova
                      </Button>
                    </div>
                    {choice("La fonte la definirò dopo", () => {
                      say("Definirò la fonte dopo.");
                      setStage("schedule");
                    })}
                  </>
                )}
                {stage === "schedule" && (
                  <>
                    <p className="text-sm">Quando deve partire?</p>
                    <div className="flex flex-wrap gap-2">
                      {[
                        ["event", "Un evento"],
                        ["time", "Giorni e orario"],
                        ["interval", "A intervalli"],
                      ].map(([value, label]) => (
                        <Button
                          key={value}
                          size="sm"
                          variant={trigger === value ? "secondary" : "outline"}
                          aria-pressed={trigger === value}
                          onClick={() => {
                            setTrigger(value!);
                            setError("");
                          }}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    {trigger === "event" && (
                      <label className="block text-xs">
                        Evento e condizioni
                        <Input
                          className="mt-2"
                          value={event}
                          onChange={(e) => setEvent(e.target.value)}
                          placeholder="Es. nuovo file in una cartella, solo nei feriali"
                        />
                      </label>
                    )}
                    {trigger === "time" && (
                      <>
                        <div className="flex flex-wrap gap-1">
                          {["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((day) => (
                            <Button
                              key={day}
                              size="sm"
                              variant={days.includes(day) ? "secondary" : "outline"}
                              aria-pressed={days.includes(day)}
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
                            className="mt-2"
                            type="time"
                            value={time}
                            onChange={(e) => setTime(e.target.value)}
                          />
                        </label>
                        <p className="text-xs text-muted-foreground">
                          {Intl.DateTimeFormat().resolvedOptions().timeZone}
                        </p>
                      </>
                    )}
                    {trigger === "interval" && (
                      <label className="block text-xs">
                        Ogni quanti minuti
                        <Input
                          className="mt-2"
                          type="number"
                          min="1"
                          value={interval}
                          onChange={(e) => setInterval(e.target.value)}
                        />
                      </label>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Prima di inviare o modificare qualcosa, ti chiederà conferma. In questa prova
                      non viene attivato nulla.
                    </p>
                    {error && (
                      <p role="alert" className="text-sm text-destructive">
                        {error}
                      </p>
                    )}
                    <Button onClick={saveRoutine}>Conserva la proposta</Button>
                  </>
                )}
                {stage === "saved" && (
                  <>
                    <p className="text-sm font-medium">La proposta di routine è pronta.</p>
                    <p className="text-sm">{routine}</p>
                    <p className="text-xs text-muted-foreground">
                      Non attiva · {connected ? "casella simulata" : "fonte da collegare"}
                      {!example ? " · lavoro da definire" : ""}. Nessun costo o esecuzione reale.
                    </p>
                    {choice("Rivedi quando parte", () => setStage("schedule"))}
                    {choice("Apri i dettagli", () => setDetails(true))}
                    {choice("Prova un altro lavoro", () => setStage("welcome"))}
                  </>
                )}
              </div>
            </div>
          </div>
          <form
            className="border-t border-border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <div className="mx-auto flex max-w-2xl items-center gap-2 rounded-2xl border border-border bg-background/70 p-2">
              <Input
                aria-label="Scrivi al collaboratore"
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="border-0 bg-transparent shadow-none"
                placeholder="Scrivi al collaboratore…"
              />
              <Button
                type="submit"
                size="icon"
                disabled={!text.trim()}
                aria-label="Invia messaggio"
              >
                <ArrowUp className="size-4" />
              </Button>
            </div>
            <p className="mt-2 text-center text-[10px] text-muted-foreground">
              Dialogo dimostrativo: il testo libero resta una nota, le scelte guidano il percorso.
              Dati conservati solo finché la pagina resta aperta.
            </p>
          </form>
        </div>
        {details && (
          <aside className="min-w-0 border-t border-border p-5 lg:border-l lg:border-t-0">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-sm font-medium">Il collaboratore</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Chiudi dettagli"
                onClick={() => setDetails(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <label className="text-xs text-muted-foreground">
              Nome
              <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-2" />
            </label>
            <div className="mt-5 space-y-5 text-sm">
              {example && (
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">Lavoro della prova</p>
                  <p>{example.title}</p>
                </div>
              )}
              {(sample || files.length > 0) && (
                <div>
                  <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Paperclip className="size-3" /> Materiali
                  </p>
                  <p className="break-words">
                    {sample ? "Materiali dimostrativi" : files.join(", ")}
                  </p>
                </div>
              )}
              {sample && example && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setStage("result");
                    scroll();
                  }}
                >
                  <FileText className="size-4" /> Rivedi il risultato
                </Button>
              )}
              {connected && <p>Casella dimostrativa · simulata</p>}
              {routine && (
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Routine proposta · non attiva
                  </p>
                  <button
                    className="text-left underline underline-offset-4"
                    onClick={() => {
                      setStage("schedule");
                      scroll();
                    }}
                  >
                    {routine}
                  </button>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">Costi della prova</p>
                <p className="mt-2">Nessun consumo reale</p>
              </div>
              {!example && !routine && (
                <p className="text-xs text-muted-foreground">
                  Qui compariranno materiali, risultati e routine mentre lavoriamo.
                </p>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
