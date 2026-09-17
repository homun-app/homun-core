export type Rule = {
  trigger: "manual" | "interval" | "event" | "task";
  every: number;
  weekdays: boolean;
  from: number;
  until: number;
  source: string;
  dependency: string;
  needsFile: boolean;
  approval: boolean;
  budget: number;
  runCost: number;
};
export type Simulation = {
  minute: number;
  phase: "waiting" | "running" | "review" | "delivered" | "paused" | "error";
  file: boolean;
  result: boolean;
  spent: number;
  runs: number;
  next: number;
  seen: string[];
  log: string[];
  version: number;
  armed: boolean;
};
export type SimEvent =
  | "tick"
  | "start"
  | "file"
  | "duplicate"
  | "dependency"
  | "finish"
  | "approve"
  | "pause"
  | "resume"
  | "fail"
  | "retry"
  | "changed";
export const defaultRule: Rule = {
  trigger: "manual",
  every: 120,
  weekdays: true,
  from: 9,
  until: 17,
  source: "Arrivo di un file",
  dependency: "",
  needsFile: false,
  approval: true,
  budget: 1,
  runCost: 0.1,
};
export const initialSimulation = (): Simulation => ({
  minute: 9 * 60,
  phase: "waiting",
  file: false,
  result: false,
  spent: 0,
  runs: 0,
  next: 9 * 60,
  seen: [],
  log: [],
  version: 1,
  armed: false,
});
export function windowOpen(minute: number, r: Rule) {
  const day = Math.floor(minute / 1440) % 7,
    hour = (minute % 1440) / 60;
  return (!r.weekdays || day < 5) && hour >= r.from && hour < r.until;
}
export function nextWindow(minute: number, r: Rule) {
  let value = minute;
  for (let i = 0; i < 8 * 1440; i++, value++) if (windowOpen(value, r)) return value;
  return minute + 1440;
}
export function simTime(minute: number) {
  const days = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
  return (
    days[Math.floor(minute / 1440) % 7] +
    " " +
    String(Math.floor((minute % 1440) / 60)).padStart(2, "0") +
    ":" +
    String(minute % 60).padStart(2, "0")
  );
}
export function transition(previous: Simulation, event: SimEvent, r: Rule): Simulation {
  const s: Simulation = { ...previous, seen: [...previous.seen], log: [...previous.log] };
  const log = (message: string) => {
    s.log = [simTime(s.minute) + " · " + message, ...s.log].slice(0, 40);
  };
  if (
    !Number.isFinite(r.every) ||
    r.every < 1 ||
    r.from < 0 ||
    r.until > 24 ||
    r.from >= r.until ||
    !Number.isFinite(r.budget) ||
    r.budget < 0 ||
    !Number.isFinite(r.runCost) ||
    r.runCost <= 0 ||
    (r.trigger === "task" && !r.dependency) ||
    (r.trigger === "event" && !r.source.trim())
  ) {
    log("Configurazione incompleta o non valida: nessuna esecuzione.");
    return s;
  }
  function start() {
    s.armed = true;
    if (r.trigger === "interval" && s.next <= s.minute) s.next = nextWindow(s.minute + r.every, r);
    if (s.phase === "paused") {
      log("In pausa: nessuna esecuzione avviata.");
      return;
    }
    if (["running", "review"].includes(s.phase)) {
      log("Nuovo avvio saltato: un lavoro è già in corso o da approvare.");
      return;
    }
    if (s.phase === "error") {
      log("Errore da risolvere: usa Riprova.");
      return;
    }
    if (!windowOpen(s.minute, r)) {
      s.next = nextWindow(s.minute, r);
      log("Fuori orario: prossimo controllo " + simTime(s.next) + ".");
      return;
    }
    if (r.needsFile && !s.file) {
      s.phase = "waiting";
      log("Attesa prevista: manca il materiale.");
      return;
    }
    if ((r.trigger === "task" || r.dependency) && !s.result) {
      s.phase = "waiting";
      log("Attesa prevista: manca il risultato dell’incarico collegato.");
      return;
    }
    if (s.spent + r.runCost > r.budget + 0.000001) {
      s.phase = "paused";
      log("Limite di costo raggiunto: esecuzione sospesa prima della spesa.");
      return;
    }
    s.spent = Math.round((s.spent + r.runCost) * 100) / 100;
    s.runs++;
    s.phase = "running";
    log("Esecuzione " + s.runs + " avviata · versione materiali " + s.version + ".");
  }
  if (event === "tick") {
    s.minute += r.every;
    if (r.trigger === "interval" && s.minute >= s.next) {
      s.next = nextWindow(s.minute + r.every, r);
      start();
    } else log("Orologio avanzato. In attesa dell’evento previsto.");
  }
  if (event === "start") start();
  if (event === "pause") {
    s.phase = "paused";
    log("Routine messa in pausa manualmente. Il lavoro di prova corrente viene interrotto.");
  }
  if (event === "resume") {
    s.phase = "waiting";
    s.next = nextWindow(s.minute, r);
    log("Ripresa senza recuperare le esecuzioni perse. Il prossimo avvio sarà verificato.");
  }
  if (event === "file" || event === "duplicate") {
    if (s.seen.includes("file-v" + s.version)) {
      log("Evento duplicato ignorato: materiale già acquisito.");
      return s;
    }
    s.seen.push("file-v" + s.version);
    s.file = true;
    log("Materiale acquisito · versione " + s.version + ".");
    if (r.trigger === "event" || (s.phase === "waiting" && s.armed)) start();
  }
  if (event === "dependency") {
    s.result = true;
    log("Ricevuto un risultato valido dall’incarico collegato.");
    if (r.trigger === "task" || (s.phase === "waiting" && s.armed)) start();
  }
  if (event === "finish") {
    if (s.phase !== "running") {
      log("Nessuna esecuzione attiva da completare.");
      return s;
    }
    s.phase = r.approval ? "review" : "delivered";
    log(
      r.approval
        ? "Risultato pronto: serve approvazione."
        : "Risultato consegnato nella simulazione.",
    );
  }
  if (event === "approve") {
    if (s.phase !== "review") {
      log("Nessun risultato in attesa di approvazione.");
      return s;
    }
    s.phase = "delivered";
    log("Versione corrente approvata e consegnata nella simulazione.");
  }
  if (event === "changed") {
    s.version++;
    s.file = true;
    s.result = false;
    if (s.phase !== "paused") s.phase = "waiting";
    log(
      "Materiali cambiati: risultato e approvazione precedenti non più validi. Rivalutazione necessaria.",
    );
  }
  if (event === "fail") {
    if (s.phase === "running") {
      s.phase = "error";
      log("Errore simulato. Nessun tentativo automatico; costo già sostenuto conservato.");
    } else log("Nessuna esecuzione attiva da interrompere.");
  }
  if (event === "retry") {
    if (s.phase === "error") {
      s.phase = "waiting";
      start();
    } else log("Nessun errore da riprovare.");
  }
  return s;
}

export function wouldCycle(
  tasks: { id: string; rule?: { dependency: string } }[],
  owner: string,
  candidate: string,
): boolean {
  const seen = new Set<string>();
  let current = candidate;
  while (current) {
    if (current === owner || seen.has(current)) return true;
    seen.add(current);
    current = tasks.find((t) => t.id === current)?.rule?.dependency || "";
  }
  return false;
}
