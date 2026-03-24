# Idee Feature da Manus.im

> Analizzato il 2026-03-23, versione Manus 1.6 Lite.
> Idee di prodotto (non design) che vale la pena adottare in Homun.

---

## Alto Valore (poco effort, grande impatto)

| # | Feature Manus | Equivalente Homun | Effort | Priorità |
|---|---------------|-------------------|--------|----------|
| 1 | **Suggerimenti follow-up** dopo ogni risposta | Nessuno | 2g (JS) | P0 — mantiene engagement, riduce ansia "prompt vuoto" |
| 2 | **Chip azioni rapide** su chat vuota | Solo messaggio benvenuto | 1g (JS+CSS) | P0 — guida la prima interazione |
| 3 | **Visualizzazione task step** (✅/🔵 step collassabili) | Tool timeline (lista piatta) | 2g (JS+CSS) | P0 — mostra il "pensiero" dell'agente professionalmente |
| 4 | **Rating al completamento** ("Com'è stato?" ⭐) | Nessuno | 1g (JS) | P1 — feedback loop per qualità |
| 5 | **Banner connettori** sotto input ("Collega i tuoi strumenti") con icone servizi | Solo pagina MCP | 1g (JS+CSS) | P1 — scoperta delle integrazioni |
| 6 | **Ricerca command palette** include sezioni settings | Cmd+K solo per pagine | 0.5g (JS) | P1 — discoverability |

## Medio Valore (effort medio)

| # | Feature Manus | Equivalente Homun | Effort | Note |
|---|---------------|-------------------|--------|------|
| 7 | **Progetti** come unità organizzative (raggruppare task per progetto) | Solo sessioni | 1 sett | Servirebbe migration DB. Sessioni → Progetti + Task |
| 8 | **Libreria** (archivio output — tutti i file generati in un posto) | Knowledge page (doc input) | 3g | Inverso del RAG — artefatti output, non doc input |
| 9 | **Pagina personalizzazione** (nickname, occupazione, istruzioni custom, doc conoscenza) | USER.md + tool remember | 2g | UI bella sopra file brain/ esistenti |
| 10 | **Canale mail** con indirizzo @homun.bot personalizzato | Canale Email (IMAP) | 1 sett | Onboarding più semplice della config IMAP |
| 11 | **Email workflow** (email diverse → automazioni diverse) | Automazioni (trigger-based) | 3g | Elegante ponte email-to-automazione |
| 12 | **Lista mittenti approvati** in UI | Config allow_from | 1g | Esiste già in config, serve UI bella |

## Da Saltare (non rilevanti per Homun)

| Feature Manus | Perché saltare |
|---|---|
| Billing a crediti | Homun è local/self-hosted, niente crediti |
| Browser cloud | Homun ha browser automation locale |
| Branding "from ∞ Meta" | Non applicabile |
| Card promo download app | Homun è già desktop-native |
| Integrazione Zapier | MCP copre questo caso d'uso |
| Programma referral | Prematuro per v1 |

---

## Insight Architetturali

1. **Navigazione piatta > gerarchia profonda** — Manus ha solo 4 voci top-level. Tutto il resto è nel modale Settings. Homun ha 8 top-level + 6 subnav = 14 target. Appiattire.

2. **Task > conversazioni** — Manus inquadra le interazioni come "compiti" con ciclo di vita (creato → in corso → completato). L'inquadramento a task dà stati di completamento naturali + rating.

3. **Consolidamento settings** — 12 sezioni in un modale vs 12 pagine separate. Più veloce (no page reload) e più scopribile.

4. **Disclosure progressiva dei tool** — Mostrare icone connettori sotto l'input. Far emergere le integrazioni dove l'utente digita.

5. **Cerimonia di completamento** — "✅ Attività completata" + rating + suggerimenti follow-up. Crea senso di realizzazione.
