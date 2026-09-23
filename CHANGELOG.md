# Changelog

All notable changes to Homun are documented here. This is the single source of
truth: the released version's section is written into the GitHub Release body
(from which the app shows the in-app "What's new" on update).

Section headers are `## Highlights` / `## Improvements` / `## Fixes` (H2), and
each bullet is a single line; version delimiters are `## [x.y.z] — date`.

## [Unreleased]

## [0.2.1] — 2026-09-23

Pulizia dell'esperienza per chi installa da zero: via ogni traccia dell'ambiente di sviluppo.

## Fixes
- **Identità neutra per il primo avvio.** Un nuovo utente si chiama «Tu» (modificabile in Impostazioni), non più con l'identità demo dello sviluppo.
- **Rimossi i riferimenti di sviluppo dall'interfaccia**: il link «Versione precedente» nella barra laterale, l'indicatore tecnico nell'intestazione, l'etichetta «PROTOTIPO», la sezione e i link dei dati demo (restano solo nell'ambiente di sviluppo), e le diciture fuorvianti «Archivio locale» e «Catalogo dimostrativo».

## [0.2.0] — 2026-09-22

La nuova generazione di Homun: lo stesso assistente che delega lavoro reale ai collaboratori, ricostruito su un motore conversazionale locale con approvazione umana esplicita per ogni esecuzione.

## Highlights
- **Il collaboratore scrive il lavoro con il suo modello.** Le fasi di sintesi producono bozze vere (cataloghi, relazioni) a partire da materiali, vincoli e procedure approvate, sempre consegnate in revisione alla persona; ogni modello usato è dichiarato nell'artifact.
- **Niente più esecuzioni silenziose.** Confronto CSV, lettura materiali, chiamate a strumenti MCP e sintesi nascono come proposte con digest che approvi tu: il motore non esegue nulla senza un tuo via esplicito.
- **Lavori multi-fase dall'accordo all'esito.** L'intake conversazionale propone obiettivo, collaboratore e fasi; ogni fase avanza con la tua verifica e il lavoro si chiude con un risultato revisionato.
- **Ogni collaboratore ha il suo modello.** La connessione preferita per agente è scelta dalla sua scheda e usata davvero dalla sua fase di sintesi, con fallback dichiarato.
- **Le procedure imparate guidano il lavoro.** I messaggi dell'agente diventano procedure approvate («Salva come procedura») e il loro corpo entra nel contesto delle sintesi successive.
- **Automazioni a motore.** Routine ricorrenti su scheduler durevole con pausa, ripresa, salta-prossima e revisione del modello; ogni ricorrenza resta supervisionata.
- **Strumenti esterni MCP con catalogo curato.** Server dichiarati con allowlist e probe onesto, esecuzione supervisionata con risultato in revisione; voci verificate nel repository, inerti finché non le dichiari.

## Improvements
- **Impostazioni complete**: persone, modelli con consigli per attività, budget e routing, agenti, team, plugin, skill, automazioni, memoria, archivio.
- **Budget per lavoro**: tentativi e token contati per ogni lavoro, con riserve atomiche ed esaurimento tipizzato che si alza solo esplicitamente.
- **Documenti e scadenze**: libreria degli artifact del motore e vista scadenze collegata ai lavori.
- **Motore Python locale autonomo**: bundle verificato da receipt con dipendenze hash-lockate, incluso nell'app; nessun servizio esterno richiesto.
- **Sicurezza dell'app**: fuses di hardening, sandbox, context isolation, CSP e proxy delle API con token mai nel renderer.

## Fixes
- **Aggiornamenti non firmati impossibili**: la pipeline di rilascio rifiuta una release macOS senza firma e notarizzazione invece di pubblicarla nel feed di aggiornamento.
