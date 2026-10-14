/**
 * Stato del motore e fonte dei dati raccontati nel thread, non nel banner.
 *
 * Il modulo puro `chat-status-notices` decide COSA mostrare a partire dallo
 * stato del client; i componenti lo disegnano negli slot del thread senza
 * mai passare dall'elenco messaggi del runtime della chat.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { componentRenderer } from "./helpers/render-component.ts";
import {
  chatStatusLayout,
  chatStatusNotices,
  conversationFollowupBadge,
  simulationSourceNotice,
  type ChatStatusNotice,
  type ChatStatusState,
} from "../apps/web/src/lib/chat-status-notices.ts";
import { nextResolvedEpisode } from "../apps/web/src/hooks/useTransientResolved.ts";
import {
  homunErrorFromHttp,
  HomunClientError,
  isHomunClientError,
} from "../apps/web/src/lib/homun-errors.ts";

const healthyEngine: ChatStatusState = {
  dataSource: "engine",
  gateError: null,
  error: null,
  followups: [],
};

const followup = (over: Partial<ChatStatusState["followups"][number]>) => ({
  commandId: "cmd-1",
  status: "processing" as const,
  errorCode: null,
  attempts: 0,
  conversationId: "conv-a",
  conversationTitle: "Listini",
  ...over,
});

test("sano in modalità motore: nessun avviso, in nessuno slot", () => {
  const notices = chatStatusNotices(healthyEngine);
  assert.deepEqual(notices, []);
  assert.deepEqual(chatStatusLayout(notices, "conv-a"), {
    aboveComposer: [],
    threadTop: [],
    threadEnd: [],
  });
});

test("simulazione: una sola dichiarazione di fonte, in cima al thread, sempre", () => {
  const state: ChatStatusState = {
    ...healthyEngine,
    dataSource: "simulation",
  };
  const notices = chatStatusNotices(state);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.id, "simulation-source");
  assert.equal(notices[0]!.scope, "global");
  assert.equal(notices[0]!.kind, "simulation-source");
  assert.equal(notices[0]!.severity, "info");
  assert.match(notices[0]!.text, /Fonte: simulazione — nessun dato reale è collegato\./);
  // l'helper diretto dichiara la stessa fonte, senza fabbricare uno stato
  assert.deepEqual(simulationSourceNotice(), notices);
  // con e senza conversazione aperta la dichiarazione resta in cima al thread
  for (const open of ["conv-a", null]) {
    const layout = chatStatusLayout(notices, open);
    assert.deepEqual(
      layout.threadTop.map((n) => n.id),
      ["simulation-source"],
    );
    assert.deepEqual(layout.aboveComposer, []);
    assert.deepEqual(layout.threadEnd, []);
  }
});

test("motore irraggiungibile: un solo avviso globale, stesse azioni e stesso errore tipizzato del banner", () => {
  const gateError = new Error("Engine data source selected, but the engine is not connected.");
  const notices = chatStatusNotices({
    ...healthyEngine,
    gateError,
    canOpenModels: true,
    workCount: 1,
  });
  assert.equal(notices.length, 1);
  const notice = notices[0]!;
  assert.equal(notice.id, "engine-unreachable");
  assert.equal(notice.scope, "global");
  assert.equal(notice.kind, "engine-unreachable");
  assert.equal(notice.severity, "error");
  assert.match(notice.text, /Homun non è raggiungibile su questo computer\./);
  // suggerimento breve, senza la frase per sviluppatori sul percorso dati
  assert.match(notice.hint!, /Avvialo, poi premi Riprova o controlla i modelli collegati\./);
  assert.doesNotMatch(notice.hint!, /simulazione/i);
  assert.doesNotMatch(notice.hint!, /percorso motore/i);
  assert.equal(notice.error, gateError);
  assert.deepEqual(notice.actions, [
    { id: "refresh", label: "Riprova" },
    { id: "open-models", label: "Apri modelli" },
  ]);
  // mai l'etichetta di simulazione mentre si è sul percorso motore
  assert.doesNotMatch(JSON.stringify(notices), /Fonte: simulazione/);
  const layout = chatStatusLayout(notices, "conv-a");
  assert.deepEqual(
    layout.aboveComposer.map((n) => n.id),
    ["engine-unreachable"],
  );
  assert.deepEqual(layout.threadTop, []);
  assert.deepEqual(layout.threadEnd, []);
});

test("motore irraggiungibile senza modelli configurabili e lista vuota: azione e hint coerenti", () => {
  const notices = chatStatusNotices({
    ...healthyEngine,
    gateError: new Error("offline"),
    workCount: 0,
  });
  const notice = notices[0]!;
  assert.deepEqual(notice.actions, [{ id: "refresh", label: "Riprova" }]);
  assert.match(notice.hint!, /Avvialo, poi premi Riprova\./);
  assert.match(notice.hint!, /La lista lavori resta vuota finché la connessione non torna\./);
});

test("un solo guasto, un solo avviso: l'errore di connessione non raddoppia l'irraggiungibile", () => {
  // il guasto reale del client: la connessione al motore caduta (stesso
  // codice che accende l'avviso di gate), sia dalla mappatura HTTP…
  const fromHttp = homunErrorFromHttp(
    503,
    {
      detail: {
        code: "engine_unavailable",
        message: "Engine unreachable at http://127.0.0.1:8765",
      },
    },
    "offline",
  );
  // …sia dall'errore che avvolge i fetch caduti
  const fromFetch = new HomunClientError(
    "engine_unavailable",
    "Engine unreachable at http://127.0.0.1:8765",
  );
  const gateError = new Error("offline");
  for (const connectionLoss of [fromHttp, fromFetch]) {
    const notices = chatStatusNotices({
      ...healthyEngine,
      gateError,
      error: connectionLoss,
    });
    assert.equal(notices.length, 1, "una sola condizione dichiarata, non due");
    assert.equal(notices[0]!.kind, "engine-unreachable");
    // l'avviso superstite resta quello del gate, con il suo stesso errore
    assert.equal(notices[0]!.error, gateError);
    assert.equal(
      notices.some((n) => n.kind === "engine-error"),
      false,
    );
  }
});

test("motore irraggiungibile con errore di altro tipo: due avvisi distinti restano visibili", () => {
  const notices = chatStatusNotices({
    ...healthyEngine,
    gateError: new Error("offline"),
    error: homunErrorFromHttp(
      503,
      { detail: { code: "provider_unavailable", message: "Local model interpret failed" } },
      "fallback",
    ),
  });
  assert.deepEqual(
    notices.map((n) => n.kind),
    ["engine-unreachable", "engine-error"],
  );
});

test("errore tipizzato del client: avviso globale sopra il campo di scrittura", () => {
  const failure = { code: "provider_unavailable" };
  const notices = chatStatusNotices({ ...healthyEngine, error: failure });
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.kind, "engine-error");
  assert.equal(notices[0]!.severity, "error");
  assert.equal(notices[0]!.error, failure);
  const layout = chatStatusLayout(notices, "conv-a");
  assert.deepEqual(
    layout.aboveComposer.map((n) => n.kind),
    ["engine-error"],
  );
});

test("followup: uno per condizione, con scope conversazione, comando e gravità giusti", () => {
  const notices = chatStatusNotices({
    ...healthyEngine,
    followups: [
      followup({
        commandId: "cmd-1",
        status: "failed",
        errorCode: "provider_unavailable",
        attempts: 3,
      }),
      followup({ commandId: "cmd-2", status: "retry_scheduled", attempts: 1 }),
      followup({ commandId: "cmd-3", status: "processing" }),
    ],
  });
  assert.deepEqual(
    notices.map((n) => n.id),
    ["followup:cmd-1", "followup:cmd-2", "followup:cmd-3"],
  );
  for (const notice of notices) {
    assert.equal(notice.scope, "conversation");
    assert.equal(notice.conversationId, "conv-a");
    assert.equal(notice.conversationTitle, "Listini");
  }
  const [failed, retry, processing] = notices as [
    ChatStatusNotice & { followup: { status: string; attempts: number; errorCode: string | null } },
    ChatStatusNotice,
    ChatStatusNotice,
  ];
  assert.equal(failed.severity, "error");
  assert.match(
    failed.text,
    /Risposta non completata dopo 3 tentativi\. Il recupero automatico è terminato\./,
  );
  assert.ok(isHomunClientError(failed.error));
  assert.equal((failed.error as { code: string }).code, "provider_unavailable");
  assert.equal(retry.severity, "warning");
  assert.match(retry.text, /Risposta interrotta; un nuovo tentativo è programmato\./);
  assert.equal(processing.severity, "info");
  assert.match(processing.text, /Risposta in elaborazione o in attesa di recupero\./);
  // un solo tentativo: accordo singolare come nel banner
  const single = chatStatusNotices({
    ...healthyEngine,
    followups: [followup({ commandId: "cmd-x", status: "failed", attempts: 1 })],
  })[0]!;
  assert.match(single.text, /dopo 1 tentativo\./);
});

test("i followup di una conversazione non compaiono nel thread di un'altra", () => {
  const notices = chatStatusNotices({
    ...healthyEngine,
    followups: [
      followup({ commandId: "cmd-a1", status: "failed", attempts: 2, conversationId: "conv-a" }),
      followup({ commandId: "cmd-a2", status: "processing", conversationId: "conv-a" }),
      followup({
        commandId: "cmd-b1",
        status: "retry_scheduled",
        attempts: 1,
        conversationId: "conv-b",
        conversationTitle: "Logs",
      }),
    ],
  });
  const openA = chatStatusLayout(notices, "conv-a");
  assert.deepEqual(
    openA.threadEnd.map((n) => n.id),
    ["followup:cmd-a1", "followup:cmd-a2"],
  );
  assert.deepEqual(openA.aboveComposer, []);
  const openB = chatStatusLayout(notices, "conv-b");
  assert.deepEqual(
    openB.threadEnd.map((n) => n.id),
    ["followup:cmd-b1"],
  );
  // nessuna conversazione aperta: nessun followup nel thread
  assert.deepEqual(chatStatusLayout(notices, null).threadEnd, []);
});

test("combinazione: irraggiungibile sopra il composer, followup in fondo, simulazione in cima", () => {
  const notices = [
    ...simulationSourceNotice(),
    ...chatStatusNotices({ ...healthyEngine, gateError: new Error("offline") }),
    ...chatStatusNotices({
      ...healthyEngine,
      followups: [followup({ commandId: "cmd-9", status: "processing" })],
    }),
  ];
  const layout = chatStatusLayout(notices, "conv-a");
  assert.deepEqual(
    layout.threadTop.map((n) => n.kind),
    ["simulation-source"],
  );
  assert.deepEqual(
    layout.aboveComposer.map((n) => n.kind),
    ["engine-unreachable"],
  );
  assert.deepEqual(
    layout.threadEnd.map((n) => n.kind),
    ["followup"],
  );
});

test("indicatore laterale: titolo onesto per conversazioni con followup", () => {
  assert.equal(conversationFollowupBadge([]), null);
  assert.deepEqual(
    conversationFollowupBadge([
      { status: "processing", commandId: "c", errorCode: null, attempts: 0 },
    ]),
    {
      tone: "attention",
      title: "Risposta in elaborazione o in attesa di recupero",
    },
  );
  assert.deepEqual(
    conversationFollowupBadge([
      { status: "retry_scheduled", commandId: "c", errorCode: null, attempts: 1 },
      { status: "failed", commandId: "c2", errorCode: "provider_unavailable", attempts: 3 },
    ]),
    { tone: "error", title: "Risposta non completata: apri la conversazione" },
  );
});

test("esito breve: un episodio attivo produce un solo esito, quando sparisce", () => {
  // montaggio a condizione spenta: silenzio, nessun esito
  assert.deepEqual(nextResolvedEpisode(false, false), { seen: false, resolved: false });
  // la condizione si attiva: memorizzata, ancora nessun esito
  assert.deepEqual(nextResolvedEpisode(false, true), { seen: true, resolved: false });
  // sparisce: UN esito e l'episodio è chiuso
  assert.deepEqual(nextResolvedEpisode(true, false), { seen: false, resolved: true });
  // resta spenta senza un nuovo episodio: silenzio, non ricompare
  assert.deepEqual(nextResolvedEpisode(false, false), { seen: false, resolved: false });
  // nuovo episodio → nuovo esito alla sua fine
  assert.deepEqual(nextResolvedEpisode(false, true), { seen: true, resolved: false });
  assert.deepEqual(nextResolvedEpisode(true, false), { seen: false, resolved: true });
});

test("avviso singolo: ruolo alert per gli errori, status per il resto", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/chat/ChatStatusNotice.tsx",
    "ChatStatusNotice",
  );
  try {
    const info = ui.render({
      notice: simulationSourceNotice()[0],
    });
    assert.match(info, /role="status"/);
    assert.match(info, /data-chat-status="simulation-source"/);
    assert.match(info, /Fonte: simulazione/);
    assert.doesNotMatch(info, /role="alert"/);

    const failing = chatStatusNotices({
      ...healthyEngine,
      gateError: new Error("offline"),
      canOpenModels: true,
    })[0];
    const alert = ui.render({ notice: failing, onAction: () => {}, busy: false });
    assert.match(alert, /role="alert"/);
    assert.match(alert, /Riprova/);
    assert.match(alert, /Apri modelli/);
    assert.match(alert, /Avvialo, poi premi Riprova/);
    // errore tipizzato ripreso da HomunErrorNotice, con la sua classe dedicata
    assert.match(alert, /cw-chat-status__error/);
    assert.match(alert, /role="alert"/);

    const busy = ui.render({ notice: failing, onAction: () => {}, busy: true });
    assert.match(busy, /Riprova<\/button>/);
    assert.match(busy, /disabled=""/);
  } finally {
    await ui.close();
  }
});

test("slot sopra il composer: avvisi globali ed esito breve «Connessione ripristinata»", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/chat/ChatStatusNotices.tsx",
    "ComposerStatusNotices",
  );
  try {
    const quiet = ui.render({ notices: [], resolved: false });
    assert.equal(quiet, "");

    const offline = ui.render({
      notices: chatStatusNotices({
        ...healthyEngine,
        gateError: new Error("offline"),
        canOpenModels: true,
      }),
      resolved: false,
      onAction: () => {},
    });
    assert.match(offline, /non è raggiungibile/);
    assert.match(offline, /Riprova/);

    const restored = ui.render({ notices: [], resolved: true });
    assert.match(restored, /Connessione ripristinata/);
    assert.match(restored, /role="status"/);
  } finally {
    await ui.close();
  }
});

test("nessun testo grezzo all'utente: i motivi passano dal mapping di prodotto", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/chat/ChatStatusNotice.tsx",
    "ChatStatusNotice",
  );
  try {
    // l'errore nasce nello stesso grafo vite del componente: instanceof su
    // HomunClientError funziona solo entro lo stesso bundle
    const errorsModule = (await ui.loadModule(
      "/apps/web/src/lib/homun-errors.ts",
    )) as typeof import("../apps/web/src/lib/homun-errors.ts");
    const rawException = new errorsModule.HomunClientError(
      "unknown",
      "Local model interpret failed: [Errno 61] Connection refused",
    );
    const notice = chatStatusNotices({ ...healthyEngine, error: rawException })[0]!;
    const markup = ui.render({ notice });
    assert.match(markup, /Errore imprevisto\./);
    assert.doesNotMatch(markup, /Errno/);
    assert.doesNotMatch(markup, /Local model interpret/);

    // lo stesso testo grezzo con il codice vero del motore: la copia di
    // prodotto del codice vince sul messaggio grezzo
    const providerDown = new errorsModule.HomunClientError(
      "provider_unavailable",
      "Local model interpret failed: [Errno 61] Connection refused",
    );
    const providerNotice = chatStatusNotices({ ...healthyEngine, error: providerDown })[0]!;
    const providerMarkup = ui.render({ notice: providerNotice });
    assert.match(providerMarkup, /Il modello non è disponibile\./);
    assert.doesNotMatch(providerMarkup, /Errno/);
  } finally {
    await ui.close();
  }
});

test("slot in fondo al thread: i followup della conversazione aperta, con errore tipizzato", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/chat/ChatStatusNotices.tsx",
    "ThreadEndStatusNotices",
  );
  try {
    // l'errore tipizzato nasce nello stesso grafo vite del componente:
    // instanceof su HomunClientError funziona solo entro lo stesso bundle
    const noticesModule = (await ui.loadModule(
      "/apps/web/src/lib/chat-status-notices.ts",
    )) as typeof import("../apps/web/src/lib/chat-status-notices.ts");
    const failed = noticesModule.chatStatusNotices({
      ...healthyEngine,
      followups: [
        followup({
          commandId: "cmd-1",
          status: "failed",
          errorCode: "provider_unavailable",
          attempts: 3,
        }),
      ],
    })[0]!;
    const markup = ui.render({ notices: [failed] });
    assert.match(markup, /data-chat-status-slot="thread-end"/);
    assert.match(markup, /Risposta non completata dopo 3 tentativi/);
    assert.match(markup, /data-error-code="provider_unavailable"/);
    assert.match(markup, /role="alert"/);
  } finally {
    await ui.close();
  }
});

test("stage motore: avvisi nel thread e nel composer, non tra i messaggi del runtime", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/chat/EngineAgentChat.tsx",
    "EngineAgentChat",
  );
  const followups = [
    followup({
      commandId: "cmd-a1",
      status: "failed",
      errorCode: "provider_unavailable",
      attempts: 3,
    }),
    followup({
      commandId: "cmd-b1",
      status: "processing",
      conversationId: "conv-b",
      conversationTitle: "Logs",
    }),
  ];
  const props = (over: Record<string, unknown>) => ({
    conversationId: "conv-a",
    activeWorkId: "w-1",
    onSend: () => {},
    notice: "",
    onClearNotice: () => {},
    engineBusy: false,
    historyLoading: false,
    references: [],
    assignee: "",
    scenarios: [],
    spaceData: { teams: [], projects: [], routines: [] },
    onCreateExample: () => {},
    ...over,
  });
  try {
    const notices = [
      ...chatStatusNotices({
        ...healthyEngine,
        gateError: new Error("offline"),
        canOpenModels: true,
      }),
      ...chatStatusNotices({ ...healthyEngine, followups }),
    ];
    const out = ui.render({ ...props({}), statusNotices: notices });

    // globale sopra il campo di scrittura, con le due azioni
    assert.match(out, /data-chat-status-slot="composer"/);
    assert.match(out, /non è raggiungibile/);
    assert.match(out, /Riprova/);
    assert.match(out, /Apri modelli/);
    // il campo di scrittura dichiara il motivo: disabilitato con il testo conservato
    assert.match(out, /<textarea[^>]* disabled=""/);
    // followup solo della conversazione aperta, in fondo al thread
    assert.match(out, /data-chat-status-slot="thread-end"/);
    assert.match(out, /Risposta non completata dopo 3 tentativi/);
    // il followup dell'altra conversazione non entra in questo thread
    assert.doesNotMatch(out, /Risposta in elaborazione o in attesa di recupero/);

    // a motore sano nessun avviso e composer abilitato
    const healthy = ui.render({ ...props({}), statusNotices: [] });
    assert.doesNotMatch(healthy, /data-chat-status/);
    assert.doesNotMatch(healthy, /<textarea[^>]* disabled=""/);
  } finally {
    await ui.close();
  }
});

test("stage simulazione: la fonte è dichiarata in cima, prima dei messaggi e fuori dalle bolle", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/ConversationWorkspaceChatStage.tsx",
    "ConversationWorkspaceChatStage",
  );
  const props = {
    work: undefined,
    scenario: null,
    panelOpen: false,
    spaceData: { teams: [], projects: [], routines: [] },
    scenarios: [],
    assignee: "",
    active: null,
    viewer: "Fabio",
    notice: "",
    storageStatus: "",
    planEdit: null,
    contributionPanel: null,
    conversationActions: () => null,
    historyRef: { current: null },
    details: null,
    onCreateExample: () => {},
    onOpenWork: () => {},
    onPreview: () => {},
    onApprovePlan: () => {},
    onApplyPlanEdit: () => {},
    onCancelPlanEdit: () => {},
    onSend: () => {},
    onClearNotice: () => {},
    engineMode: false,
    onRefreshEngine: () => Promise.resolve(),
  };
  try {
    const simulation = ui.render({ ...props, dataSource: "simulation" });
    assert.match(simulation, /Fonte: simulazione — nessun dato reale è collegato\./);
    assert.match(simulation, /role="status"/);
    assert.match(simulation, /data-chat-status-slot="thread-top"/);
    // in modalità motore lo stesso stage non dichiara nessuna fonte
    const engine = ui.render({ ...props, dataSource: "engine" });
    assert.doesNotMatch(engine, /Fonte:/);
  } finally {
    await ui.close();
  }
});
