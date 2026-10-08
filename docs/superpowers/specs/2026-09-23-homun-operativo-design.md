# Homun operativo e squadra aziendale

Mandato: il 23 settembre Fabio autorizza a procedere in autonomia verso
l'obiettivo del rapporto `docs/research/2026-09-23-visione-prodotto-gap.md`.
Le scelte ordinarie di progetto e implementazione non richiedono nuovi gate.

## Risultato

Homun svolge direttamente richieste senza costringere alla creazione di bot.
Lo stesso motore supporta collaboratori specializzati facoltativi e un percorso
per raccontare l'azienda e proporre la squadra. Ruolo dell'esecutore, titolarità
umana e autorizzazioni restano distinti. Le persone devono poter contribuire con
identità reali; un invito simulato non è completamento del prodotto.

## Architettura e alternative

Estendere dominio, ModelPort e DBOS già adottati. Rifiutata l'alternativa di
moltiplicare sole capability verticali: non realizza il ciclo adattivo. Un motore
esterno introdurrebbe doppia autorità su stato/effetti senza necessità dimostrata.
Componenti piccoli con contratti tipizzati; nessuna nuova pipeline parallela
per ciascun settore.

## Incrementi e contratti

1. Esecuzione diretta: staffing nullo significa Homun sulla connessione attiva;
   nessun profilo fittizio persistito. Il proprietario umano resta tale. Staffing
   esplicito mantiene comportamento e connessione dell'agente. Sintesi, lettura
   e confronto devono attraversare proposta, approvazione e revisione in entrambi
   i casi. L'UI dichiara Homun dove non è stato delegato un collaboratore.
2. Ciclo adattivo: decisioni strutturate, strumenti descritti da schema,
   osservazioni persistite, limiti di passi/budget, cancellazione e ripresa.
   Prima superficie: materiali autorizzati e artifact, usando le stesse fonti
   e controlli esistenti. Nuovi effetti esterni restano proposte autorizzabili;
   MCP richiede registrazione durabile e gestione degli esiti incerti.
3. Onboarding: conversazione persistente di contesto organizzativo, proposta
   modificabile di squadra, creazione confermata con gli stessi AgentProfile e
   Team. Nessuna competenza o integrazione dichiarata pronta solo dal nome.
4. Collaborazione: registro persone, credenziali per identità distinte, invito e
   contributi sul lavoro, coordinamento con deleghe validate dal dominio.
   Non esporre il server locale in rete senza un contratto di distribuzione.
5. UX integrata: due ingressi alla stessa superficie; richiesta, avanzamento,
   contributi e consegna comprensibili. Le configurazioni emergono al bisogno.

## Verifica

Ogni incremento: test di comportamento prima delle modifiche; suite mirate,
regressioni di autorizzazione/revisione/idempotenza, typecheck e build per UI.
Accettazione finale: richiesta senza bot, strumento/osservazione/decisione,
onboarding corretto dall'utente, due identità e un agente, riavvio e consegna.
Prove con fake, runtime locale, provider reale e UI sono evidenze distinte.
Non chiamare completata la visione sulla base del solo incremento 1.
