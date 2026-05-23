# ADR 0002: Local Computer Session e UX operativa stile Manus

## Stato

Accettata.

## Contesto

L'analisi live di Manus ha chiarito un punto di prodotto: l'assistant deve far vedere cosa sta facendo senza trasformare la UI in un pannello tecnico permanente.

Il prototipo Tauri iniziale con sidebar, chat e inspector ha permesso di testare la direzione visuale, ma l'inspector fisso rende la schermata troppo densa e poco leggibile. Manus risolve meglio il problema con progressive disclosure: chat centrale, menu contestuali, popover, modal, timeline inline e una card "computer" che mostra il lavoro in corso.

Il nostro progetto pero' ha vincoli diversi:

- local-first.
- Rust Core owner di policy, audit e scheduling.
- task lunghi e riprendibili tramite Durable Task Runtime.
- browser automation gia' implementata come sidecar locale.
- shell e file/artifact devono essere controllati e redatti.

## Decisione

Adottiamo il modello Local Computer Session:

- il "computer" e' una sessione locale multi-superficie, non solo browser.
- le superfici iniziali sono Browser, Shell/Terminale, File/Artifact e Log.
- Browser automation e shell runner vengono visualizzati come parti dello stesso task operativo.
- Il Durable Task Runtime mantiene durata, code, priorita', lease, retry, risorse e approvazioni.
- Il Local Computer Session Manager mantiene timeline, preview, transcript redatti, artifact refs e read model UI-safe.
- La UI mostra timeline inline e activity card, con detail panel/modal on demand.
- L'inspector non e' piu' il default della chat: diventa una vista contestuale apribile quando serve.

## Conseguenze

Positive:

- UX piu' pulita e piu' vicina al modo in cui l'utente ragiona: "sta lavorando sul mio computer".
- Browser e shell non duplicano stato/task UI.
- I task di ore o giorni possono mostrare progress e preview senza log grezzi.
- Approvals e takeover diventano parte naturale dell'esperienza.
- Manteniamo separazione forte tra UI, Brain, task runtime e capability execution.

Tradeoff:

- Serve un nuovo read model intermedio invece di cablare direttamente browser/task alla UI.
- La UI va rifatta verso rail/drawer, activity card e progressive disclosure.
- Serve una shell surface controllata, non un terminale libero.
- Preview e transcript richiedono policy di retention/redaction.

## Cosa non facciamo

- Non copiamo codice, asset o layout esatti di Manus.
- Non diamo al modello controllo diretto del computer.
- Non usiamo cloud API per osservare browser/shell.
- Non implementiamo subito pieno desktop control OS-wide.

## Riferimenti

- Spec: `docs/superpowers/specs/2026-05-23-local-computer-session-ux-design.md`
- Browser automation: `docs/superpowers/specs/2026-05-23-browser-automation-design.md`
- Durable task runtime: `docs/superpowers/specs/2026-05-23-durable-task-runtime-design.md`
