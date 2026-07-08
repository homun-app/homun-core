# Verticalizzazione di Homun: modelli specializzati per settore

> Documento strategico su come evolvere Homun (oggi in beta) in un prodotto
> **enterprise dedicato alle aziende**, dando alla azienda cliente la possibilità di
> **affinare facilmente un modello in base alle proprie esigenze** — ovvero avere, oltre
> a qualsiasi modello generico, **uno specializzato nel proprio settore**.
>

---

## TL;DR — i cinque punti che contano

1. **"Verticalizzazione" è quasi sempre un problema di contesto, non di pesi.** La maggior
   parte delle aziende che chiede "un modello specializzato" non ha bisogno di
   fine-tuning: ha bisogno di *conoscenza* (RAG) + *processi* (capability) + *tono*
   (system prompt). Il fine-tuning serve solo per compiti stretti e ripetitivi.

2. **Il vero differentiator non è il fine-tuning in sé, è l'offuscamento locale dei dati.**
   Risolve il falso dilemma privacy-vs-facilità: trasformi i dati sensibili in "sample
   data" **sul Mac del cliente, prima che escano**, poi li mandi a una GPU esterna. L'azienda
   non manda fuori i propri dati: manda dati irriconoscibili. Pochi prodotti lo fanno bene.

3. **Metà dell'infrastruttura per farlo Homun ce l'ha già scritta.** I moduli di
   `redaction.rs`, `privacy_guard.rs`, il `vault`, la memoria strutturata
   (`episode`/`Candidate`/`Confirmed`, `learn_from_exchange`) e Ollama nativo sono già in
   produzione. Si tratta di *riconfigurarli* per un nuovo scopo, non di costruire da zero.

4. **Il dataset nasce gratis dal prodotto stesso.** Due sorgenti, nessuna richiede sforzo
   manuale al cliente: (a) la cronologia delle chat che l'utente fa con Homun, e (b)
   documenti caricati da cui un LLM genera coppie domanda/risposta sintetiche.

5. **La regola architetturale non-negoziabile: il fine-tuning è un job batch esplicito,
   mai sul percorso del messaggio.** La verticalizzazione non aggiunge **zero carico** al
   percorso "prompt utente → LLM". È una pipeline isolata, lanciata on-demand, il cui
   output è semplicemente "un altro modello in Ollama". Questo applica subito l'insegnamento
   chiave di `confronto-zcode-vs-homun.md`: *isola la complessità, non ottimizzarla.*

---

## 1. La trappola: "verticalizzazione" ≠ "fine-tuning"

Quando un'azienda dice "voglio un assistente specializzato nel mio settore", **nella
stragrande maggioranza dei casi non intende** "addestrami un modello". Intende:
*"voglio che conosca la nostra roba e segua i nostri processi"*. C'è uno spettro, dal
cheap al caro:

| Livello | Cosa fa | Costo | Quando serve davvero |
|---|---|---|---|
| **1. System prompt di settore** | Persona, tono, terminologia | ~0 | Sempre — sostiene gran parte dei "prodotti verticali" sul mercato |
| **2. Knowledge base (RAG)** | Il modello recupera dal sapere dell'azienda | Basso | **Questa è la vera specializzazione** per la chat |
| **3. Skill/capability di settore** | Tool dedicati (consulta ERP, compila modulo X) | Medio | Quando l'agente deve *agire*, non solo parlare |
| **4. Fine-tuning (LoRA/QLoRA)** | Cambia i pesi del modello | Alto | Per compiti stretti e ripetitivi, non per chat generale |
| **5. Distillazione** | Alleni un piccolo da uno grande | Alto | Per deployment on-device a basso costo |

**Punto cruciale.** Il fine-tuning serve per **compiti stretti e ripetitivi** (estrazione
dati da fatture, classificazione, terminologia di dominio strettissimo, formato di output
rigoroso), **non per il chat generale**. Per la chat, un buon RAG batte quasi sempre un
fine-tuning mediocre — ed è infinitamente più facile da aggiornare. Un modello fine-tuned
è *congelato*: aggiornarlo significa riaddestrarlo. Una knowledge base si aggiorna
aggiungendo un documento.

**Implicazione per Homun.** La *memoria strutturata* di Homun (grafo, FTS, vector,
lifecycle, privacy domains, wiki) è **concettualmente già il motore di verticalizzazione**.
Se la carichi di sapere di un settore (legale, edile, medico…), diventa un agente
specializzato in quel dominio. Quindi gran parte di "verticalizzazione" per Homun è un
problema di **prodottizzazione** (onboarding di settore, template pre-confezionati,
connettori per alimentare la KB), **non** di nuova tecnologia.

L'idea "oltre a usare qualsiasi modello, hai anche uno specializzato" è quindi
**fattibile** — ma *dove* sta la specializzazione (pesi vs contesto) cambia tutto il costo
e la fattibilità.

---

## 2. La logica del "no-code fine-tuning" — cosa fa realmente AnythingLLM dietro il bottone

Non c'è magia. Qualsiasi sistema "no-code fine-tuning" (AnythingLLM, OpenAI Dashboard,
LLaMA-Factory, SiliconFlow, Fireworks, FinetuneDB) esegue **cinque passi** identici:

```
1. RACCOLTA DATI  →  2. FORMATTAZIONE  →  3. TRAINING  →  4. QUANTIZZAZIONE  →  5. DEPLOY
   (harvest)         (→ JSONL)            (GPU, LoRA)    (→ GGUF)              (in Ollama)
```

**Passo 1 — Harvesting.** Niente dati = niente fine-tuning. I sistemi raccolgono coppie
*domanda → risposta buona* da: (a) chat history dell'utente (i messaggi marcati/editati
come corretti), (b) documenti trasformati in Q/A sintetici (un LLM genera domande sui PDF e
le risponde dai PDF stessi → dataset sintetico), (c) correzioni umane (DPO/RLHF leggero).
**Questo è il vero lavoro.** 200 esempi eccellenti battono 10.000 scadenti.

**Passo 2 — Formattazione → JSONL.** Ogni esempio diventa una riga JSON che usa il
*chat template* del modello target (Llama 3, Mistral, Gemma hanno template diversi). Una
riga tipica è del tipo:
```json
{"messages": [{"role":"system","content":"Sei l'assistente clienti di un'azienda di caffè."},
               {"role":"user","content":"Avete capsule compatibili?"},
               {"role":"assistant","content":"Sì! Le nostre capsule Espresso Oro sono compatibili..."}]}
```

**Passo 3 — Training (GPU).** Qui si usa **LoRA/QLoRA**: si *congelano* i pesi del modello
base e si allenano solo piccoli "adattatori" (strati aggiuntivi). Risultato: non si
modificano miliardi di parametri, ma solo qualche milione. Librerie: **Unsloth** (la più
veloce), **HuggingFace TRL**, **LLaMA-Factory**, **Axolotn**. Output: adattatori LoRA
(50–500 MB) o un modello "fuso" completo.

**Passo 4 — Quantizzazione → GGUF.** Per servire il modello localmente (su Ollama, come fa
già Homun per gli embedding), si converte nel formato **GGUF** di `llama.cpp` e si
quantizza (Q4_K_M ecc.) → un modello da 2–8 GB invece di 15+.

**Passo 5 — Deploy.** Carichi il GGUF in **Ollama** → Homun lo vede come qualsiasi altro
modelello. **Questa parte Homun ce l'ha già**, perché parla con Ollama nativamente.

> La "semplificazione no-code" di AnythingLLM è letteralmente: *nasconde i passi 1–4
> dietro un bottone e li manda a una GPU loro.* Tutto qui. Non c'è tecnologia segreta. La
> differenza competitiva sta in *come* fai i passi 1 (offuscamento + harvesting intelligente)
> e 5 (integrazione profonda col resto del prodotto).

---

## 3. L'intuizione chiave: offuscamento locale dei dati

> *L'azienda deve poter premere un bottone (facilità no-code) ma i dati sensibili non
> devono uscire dal perimetro. Soluzione: localmente, prima dell'invio, si trasformano i
> dati sensibili in "sample data" — stessi formato e struttura, ma irriconoscibili.*

Questa è l'idea che chiude il cerchio e risolve il falso dilemma privacy-vs-facilità.
Sposta la trasformazione dei dati **lato client, prima che escano**:

```
Chat/dati aziendali (grezzi, sul Mac del cliente)
        │
        ▼  [OFFUSCAZIONE LOCALE]  ← qui sta il differentiation competitivo
Dati "sample" (PII sostituiti, formato preservato)
        │
        ▼  [invio sicuro]
GPU esterna (Modal/Together/RunPod) — vede solo dati irriconoscibili
        │
        ▼  [training LoRA + quantizzazione GGUF]
Modello .gguf
        │
        ▼  [deploy]
Ollama locale → Homun
```

L'azienda può mandare i dati fuori perché **quello che esce non è più il suo dato**. Questo
è il modello AnythingLLM fatto bene, ed è un posizionamento che pochi hanno sul mercato.

### 3.1 La sfumatura tecnica che va conosciuta (onesta)

Offuscare per *chat libero* è sottile: il modello impara dagli esempi offuscati e quindi
*genera* in stile offuscato. Per il caso d'uso reale — "impara il tono/terminologia del mio
settore" — la PII è in gran parte **irrilevante**: per imparare lo stile di uno studio
legale non serve il nome vero del cliente, serve la *struttura* delle risposte. Quindi
l'offuscamento non danneggia quasi.

Per task stretti (es. estrazione dati da fatture) invece si vuole offuscamento
*format-preserving*: si sostituisce un IBAN vero con uno finto ma formalmente valido, una
partita IVA vera con una finta col check-digit corretto — così il modello impara il
pattern, non il placeholder `[REDACTED]`.

### 3.2 Requisiti dell'offuscamento per fine-tuning (diversi da quelli per chat)

L'offuscamento per fine-tuning ha tre vincoli che quello per chat non ha:

1. **Coerenza cross-esempio.** Lo stesso "Mario Rossi" deve diventare sempre `[PERSONA_1]`
   (o lo stesso nome finto) in tutto il dataset, altrimenti si distrugge il segnale di
   apprendimento. Serve una **tabella di mappatura persistente** per dataset, non una
   sostituzione stateless per-turno.
2. **Preservazione del formato.** Un codice fiscale finto ma strutturalmente valido, non
   `[REDACTED]`. Un IBAN finto col check-digit corretto. Una data resta una data.
3. **Reversibilità opzionale.** A volte (debug, audit) si vuole poter ricostruire il dato
   originale. La tabella di mappappa, se conservata cifrata lato cliente, lo permette.

---

## 4. Quello che Homun ha già (e non sa di avere per questo scopo)

L'infrastruttura di base esiste già, oggi usata per la privacy in-chat. Si tratta di
*riconfigurarla* per un nuovo scopo.

### 4.1 Layer di detection PII già funzionanti

- **`crates/memory/src/redaction.rs`** — redazione ricorsiva JSON/testo. Detecta
  `api_key`/`access_token`/`password`/`secret`/`authorization`/`cookie` e delega al vault
  per la detection strutturata (codice fiscale, IBAN, carte).
- **`crates/desktop-gateway/src/privacy_guard.rs`** — detection **deterministica** (targa,
  codice fiscale, carta di pagamento, CVV one-shot, dato sanitario) **+ detection via
  modello** con normalizzazione categoria. Già produce `redacted_text` con placeholder
  `[VAULT:vehicles:plate]`, già gestisce una normalizzazione categoria/kind.
- **`crates/vault`** — il vault che associa i valori reali ai placeholder e fa la
  classificazione `classify_sensitive_text` (ritorna `detections[]` con start/end/kind).

> **Tradotto:** il "riconoscere cosa è sensibile e sostituirlo" Homun lo sa già fare.
> Per il fine-tuning mancano solo: (1) coerenza dell'offuscamento *tra esempi diversi*
> (§3.2 punto 1), (2) preservazione del formato (§3.2 punto 2), e (3) l'assemblaggio del
> dataset JSONL + l'orchestrazione del job di training.

### 4.2 Dataset potenziale già in produzione

La memoria di Homun è **concettualmente già la sorgente dati** per il fine-tuning:

- **`learn_from_exchange`** + `Candidate`/`Confirmed` lifecycle — le risposte buone sono
  già marcate e confermate. Sono esempi domanda→risposta *pronti*.
- **`episode`** (memoria episodica scoped per workspace) — conversazioni passate
  utilizzabili come esempi.
- **`decision`** con `metadata.decision.rationale` — la *traccia del ragionamento*,
  preziosa per insegnare non solo il "cosa" ma il "perché".

### 4.3 Il resto dello stack che serve

- **`model_registry.rs`** (`ProviderRegistry`/`RoleBinding`) — il modello verticalizzato è
  semplicemente una nuova entry qui.
- **Ollama nativo** — già parla con Ollama (lo usi per `nomic-embed-text-v2-moe`). Caricare
  un GGUF è un'operazione già supportata dal runtime.
- **`task-runtime` + `RoutineRecord`** — per il job batch di training in background.

---

## 5. Su quali server mandare i dati — le 4 categorie (con privacy)

Per Homun enterprise il punto critico è: **l'azienda cliente accetta che i suoi dati
escano dal perimetro?** Con l'offuscamento locale (§3), la risposta è "*quello che esce non
è più il suo dato*" — quindi la maggior parte dei casi è risolta. Ma le opzioni di
compute restano determinanti per prezzo, latenza e narrativa.

| Categoria | Esempi | Privacy | Costo | Note |
|---|---|---|---|---|
| **A. Provider proprietario** | OpenAI, Anthropic, Gemini fine-tuning | 🔴 Dati escono al provider | $ medio | Il più semplice. Per molte aziende EU/healthcare è **vietato** anche con offuscamento. |
| **B. Cloud GPU managed (API)** | Together AI, Fireworks AI, Modal, Replicate, OpenRouter | 🟠 Dati escono, ma su macchine effimere, spesso con policy no-retention | $ basso (pay/job) | API pulita, facile da integrare. Verificare il DPA di ciascuno. |
| **C. Cloud GPU grezzo (BYO)** | RunPod, Lambda Labs, Vast.ai, TensorDock, AWS EC2 GPU | 🟡 Tu controlli la macchina, la chiudi quando vuoi, cifri il disco | $ basso (pay/hour) | Massima flessibilità tecnica, più lavoro operativo. |
| **D. On-premise / self-host** | GPU del cliente, o tuo server | 🟢 Dati non escono mai | $ alto fisso | La narrazione perfetta per Homun (local-first). |

**Caso speciale: Apple Silicon.** Su Mac (il target dichiarato di Homun) oggi si può fare
fine-tuning QLoRA di modelli piccoli (3–8B parametri) *localmente* via **MLX** o
**Unsloth-Mac**, in tempi accettabili (30–90 min per poche centinaia di esempi). Per un
prodotto "verticalizzato ma privato" è un'opzione che pochi offrono e che si sposa al 100%
con la narrativa local-first di Homun.

> **Posizionamento strategico.** Homun è local-first, usa già Ollama, e la sua memoria è
> *already* lo strumento di verticalizzazione più potente che ha. La mossa naturale **non
> è** "costruisci un sistema di fine-tuning cloud" — è **"dà all'utente la scelta di dove
> addestrare, e orchestri il job"**. La pipeline (offuscamento + dataset prep + conversione
> GGUF + deploy) la si costruisce in Rust; lo step di training (GPU) lo si delega a chi
> l'utente sceglie.

---

## 6. I tre approcci — con raccomandazione

### Approccio A — "Pipeline locale + cloud managed" (AnythingLLM-style, con privacy twist)

Homun costruisce: offuscamento (estende `redaction`/`privacy_guard`) + dataset builder
(dalle chat history via `learn_from_exchange`/`episode`) + export JSONL + invio a un
endpoint GPU scelto (Modal/Together/RunPod) + recupero GGUF + caricamento in Ollama.

- **Pro:** il più veloce da spedire, pattern collaudato, valida subito la domanda di
  mercato.
- **Contro:** i dati (pur offuscati) escono; alcune enterprise dicono comunque no.

### Approccio B — "Fine-tuning 100% locale su Apple Silicon" (max privacy, nativo Homun)

Stessa pipeline, ma il training gira **sul Mac del cliente** via MLX o Unsloth-Mac. Modelli
piccoli (3–8B), tempi 30–90 min.

- **Pro:** zero data egress, narrativa perfetta, quasi nessuno lo offre.
- **Contro:** solo Mac potenti; lento; limitato a modelli piccoli.

### Approccio C — "Orchestrazione tua, trainer pluggabile" (l'enterprise play maturo)

L'orchestrazione (offuscamento + dataset + deploy GGUF) è sempre di Homun e locale. Lo
*step di training* è un **trait Rust con più backend**: `LocalMLX`, `CloudAPI`,
`OnPremGPU`. L'utente (o l'admin) sceglie.

- **Pro:** si sposa col pattern `ProviderRegistry`/`RoleBinding` già presente in
  `model_registry.rs`; è quello che si vende alle enterprise.
- **Contro:** più lavoro iniziale.

### Raccomandazione: C, ma a fasi

Disegnare fin da subito l'astrazione `TrainerBackend` (costa poco), ma **spedire prima
solo il backend cloud (A)** perché dà valore reale subito e valida la domanda. Il backend
locale MLX (B) lo si aggiunge dopo, quando il prodotto è lanciato e ci sono clienti
enterprise che lo chiedono esplicitamente. **Non costruire B ora**: è il classico caso in
cui la versione "facile" ne copre l'80% e YAGNI regna.

---

## 7. Il principio architetturale non-negoziabile

Tutta l'analisi di `confronto-zcode-vs-homun.md` converge su un insegnamento: **"isola la
complessità, non metterla sul percorso del messaggio"**. La verticalizzazione è la feature
perfetta per applicare *subito* quel principio, perché è **intrinsecamente un job batch
esplicito, non un passo per-turno**:

```
              ┌─────────────────────────────────────────────┐
              │   PERCORSO CALDO (chat, ogni turno)          │
              │   Zero costo nuovo. Il modello verticalizzato│
              │   è solo "un altro modello" in Ollama.       │
              └─────────────────────────────────────────────┘
                              │ (nessun nuovo carico qui)
                              │
   ┌──────────────────────────┴──────────────────────────────┐
   │   PERCORSO FREDDO (job batch, esplicito, off-demand)      │
   │   L'utente preme "Affina il mio assistente"               │
   │   → harvest → offusca → dataset → train → GGUF → Ollama   │
   └───────────────────────────────────────────────────────────┘
```

**Conseguenza concreta.** Un nuovo crate (es. `tuning` o `specialization`) contiene tutta
la logica. Il gateway espone solo un endpoint `/api/tuning/start` che lancia un task in
background (si ha già `task-runtime` e i `RoutineRecord` per i job schedulati). Il modello
risultante è un'entry nel `model_registry` esistente — Homun lo tratta come qualsiasi altro
modello. **Nessuna nuova complessità sul percorso del messaggio.**

Questo fa due cose: risolve la fattibilità (è un problema batch isolato, non
architetturale) e dà una coerenza interna che la concorrenza non ha. È anche l'occasione
per applicare fin dal primo giorno la lezione centrale del confronto con ZCode/Codex:
*"sposta il motore e la memoria fuori dal percorso del messaggio"*.

---

## 8. Da dove nascono gli esempi (decisione di design)

Due sorgenti, **nessuna richiede dataset manuale** al cliente:

1. **Chat history (esistente).** Il dataset nasce dalle conversazioni che l'utente fa con
   Homun. L'utente marca le risposte buone (o le edita), e quelle diventano esempi
   domanda→risposta. Zero sforzo di raccolta — `learn_from_exchange`/`Candidate`/
   `Confirmed`/`episode` sono già la materia prima.
2. **Documenti caricati (sintetico).** L'utente carica PDF/Word/FAQ aziendali. Un LLM
   genera coppie Q/A sintetiche dai documenti (domanda generata + risposta basata sul
   documento). È come fanno i competitor, ed è il caso d'uso enterprise più comune.

Pertanto Homun non costruisce *solo* l'orchestratore, **costruisce anche il generatore di
dataset**.

---

## 9. Posizionamento competitivo — cosa rende Homun diverso

Chiunque possa integrare Ollama + AnythingLLM ha già "modello fine-tuned locale". **Il
differentiator di Homun non è il fine-tuning in sé.** È la combinazione di tre cose che
nessun competitor ha insieme:

1. **Memoria strutturata** → il dataset per il fine-tuning nasce *gratis* dalle chat
   dell'azienda (si hanno già `learn_from_exchange`, i `Candidate`/`Confirmed`, gli
   `episode`). Non c'è da raccogliere dati: li si hanno già.
2. **Capability registry di settore** → il modello verticalizzato + tool dedicati
   (consulta ERP, compila modulo X) sono l'ibrido che vale. La distinzione capability/tool
   con governance privacy è già superiore a ZCode/Codex.
3. **Offuscamento locale con opzione cloud** → "i tuoi dati restano tuoi; se vuoi
   addestrare in cloud, scegli tu dove, e quello che esce non è più il tuo dato". Pochi lo
   fanno, nessuno con questa coerenza architetturale.

---

## 10. Roadmap a fasi (suggested)

La sequence logica, dal minor al maggior rischio, ciascuna valida a sé:

**Fase 0 — Design (questo documento).** Allineamento sulla direzione e sul principio
architetturale (§7).

**Fase 1 — Dataset builder + offuscamento (locale, nessuna GPU).**
- Estendere `redaction`/`privacy_guard` con: coerenza cross-esempio, format-preserving,
  tabella di mappatura persistente per dataset (§3.2).
- Dataset builder che estrae esempi da `episode`/`Confirmed` e genera Q/A sintetiche da
  documenti caricati.
- Export JSONL. Questa fase è già utile *da sola* (l'utente può scaricare il dataset e
  addestrare ovunque).

**Fase 2 — Trainer trait + backend cloud (Approccio A).**
- Definire il trait `TrainerBackend` (vuoto/pluggable fin da subito, §6 raccomandazione C).
- Implementare `CloudAPI` backend (es. Modal o Together AI) che prende il JSONL, fa
  training LoRA, restituisce GGUF.
- Caricamento automatico in Ollama + registrazione in `model_registry`.

**Fase 3 — UX di settore.**
- Template pre-confezionati per verticali (legale, edile, medico, customer care).
- Onboarding guidato: "carica i tuoi documenti → marca 10 risposte buone → premi Affina".

**Fase 4 — Backend locale MLX (Approccio B).**
- Solo se clienti enterprise lo chiedono. Implementare `LocalMLX` come nuovo
  `TrainerBackend`. Max privacy, narrativa local-first completa.

**Fase 5 — Distillazione e modelli on-device (opzionale).**
- Per deployment a basso costo su hardware modesto del cliente.

---

## 11. Domande aperte / da validare

- **Quale provider cloud per la Fase 2?** Modal (pay/job, effimero) vs Together AI (API
  pulita, modelli hosted) vs RunPod (BYO, più controllo). Dipende da DPA e pricing.
- **Modello base di default per la verticalizzazione?** Llama 3 (8B), Mistral (7B), Gemma
  (2/7B), o Qwen? Influenza qualità, dimensione GGUF, requisiti hardware del cliente.
- **L'offuscamento è abbastanza per il GDPR/sectoral?** Anche offuscato, per alcuni settori
  (health, finance) serve validazione legale prima di spedire fuori. Forse serve una
  modalità "on-prem only" garantita fin dal marketing.
- **Come si misura la qualità del modello fine-tuned?** Serve un eval set di settore (prima
  del training) e un confronto prima/dopo. Senza eval, non si sa se il fine-tuning ha
> aiutato o peggiorato.
- **Il "modello specializzato" è una vera fetta di mercato, o è RAG che risolve il 90%?**
  Da validare con i primi clienti enterprise. Se RAG risolve quasi tutto, il fine-tuning
  resta una feature premium di nicchia (task stretti), non il core.

---

## Riferimenti


**Codice Homun rilevante:**
- `crates/memory/src/redaction.rs`, `crates/desktop-gateway/src/privacy_guard.rs`,
  `crates/vault/src/sensitive.rs` — detection/redazione PII (base per §3, §4.1).
- `crates/desktop-gateway/src/main.rs` (`learn_from_exchange`, `episode`,
  `Candidate`/`Confirmed` lifecycle) — sorgente dati (§4.2, §8).
- `crates/desktop-gateway/src/model_registry.rs` (`ProviderRegistry`, `RoleBinding`) — dove
  registra il modello verticalizzato (§4.3, §7).
- `crates/task-runtime/`, `crates/memory/src/types.rs` (`RoutineRecord`) — job batch in
  background (§7).

**Tecnologie esterne:**
- **Training:** Unsloth, HuggingFace TRL, LLaMA-Factory, Axolotn.
- **Quantizzazione/deploy:** `llama.cpp` (GGUF), Ollama.
- **Locale Apple Silicon:** MLX, Unsloth-Mac.
- **Cloud GPU:** Modal, Together AI, Fireworks AI, RunPod, Lambda Labs, Replicate.
