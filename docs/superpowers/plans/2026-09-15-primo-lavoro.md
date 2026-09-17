# Primo lavoro — piano di implementazione UX

**Obiettivo:** implementare i primi tre momenti della specifica UX 01 in una demo
locale del componente usato dalla pagina Crea, senza motore o scritture Supabase.

**Architettura:** componente React indipendente per bisogno, collaboratore,
incarico e riepilogo. Dati conservati nella sessione del browser, separati per
utente/progetto. Preparazione dell'incarico validata da un modulo TypeScript puro.
Anteprima standalone per verificare il percorso senza autenticazione o servizi.

**Stack:** React, TypeScript, componenti UI esistenti, Vite/Tailwind per anteprima.
Esecuzione in questa sessione. La cartella non contiene .git: niente branch/commit.

## Passi

- [x] Definire e verificare la preparazione di un incarico dimostrativo: input
  libero, checklist non vuota, budget remoto valido, stato soltanto «da fare».
  File: src/lib/first-work.ts; tests/first-work.test.ts.
  Comando: node --test tests/first-work.test.ts.
- [x] Creare src/components/builder/FirstWorkJourney.tsx e relativi componenti
  per i campi: bisogno libero, responsabilità, conoscenze, strumenti simulati,
  politica AI, autonomia, budget, incarico e metodo modificabile.
- [x] Conservare bozza e incarico nella sessione del browser e mantenere i dati
  tornando indietro. Se lo storage fallisce, mantenere la sessione in memoria
  e comunicare che il salvataggio non è disponibile.
- [x] Integrare nella pagina Crea, mantenendo i percorsi esistenti in una sezione
  secondaria. Il componente va rimontato al cambio utente/progetto.
- [x] Aggiungere anteprima standalone con lo stesso componente e stile esistente.
  L'anteprima non importa autenticazione o client Supabase.
- [x] Verificare tipi e build disponibili; percorrere il flusso in browser,
  controllare desktop/mobile, ritorno ai passaggi, reload, budget e checklist.
- [x] Registrare esiti e limiti e mostrare l'anteprima all'utente.

## Limiti espliciti

Nessuna generazione AI reale, nessuna connessione o invio, nessuna esecuzione o
spesa inventata. Il riepilogo termina con «Da fare · Demo» e permette di modificare
l'incarico. Collaboratori esistenti, bacheca completa, deleghe in esecuzione e
verifiche dei risultati saranno un blocco successivo. Nessuna libreria del motore
viene selezionata. Non si modifica schema dati, autenticazione o stile globale.

## Verifica effettuata il 15 settembre 2026

- `node --test tests/first-work.test.ts`: 4 test passati, dopo aver verificato
  il fallimento iniziale della preparazione dell'incarico.
- `tsc --noEmit`: passato sull'intero progetto.
- ESLint dei tre moduli nuovi in src: passato senza warning.
- `npm run build`: passato; warning di dimensione chunk, configurazione
  tsconfig paths e opzione inlineDynamicImports dal toolchain esistente.
- `npm run build:prototype`: passato.
- Browser: percorso libero sui ricambi fino alla scheda «Da fare · Demo»;
  budget -5 respinto, 2,50 accettato; checklist di tre passaggi conservata.
- Reload e navigazione indietro: incarico, nome e budget conservati.
- Screenshot ispezionati a 1280 px (ingresso), 1440 px (riepilogo) e 390 px
  (configurazione). Controllo DOM senza overflow a 390 e 320 px.
- Nessun pageerror dopo reload della versione finale. Durante la modifica
  dell'export DEMO_TOOLS il server HMR ha registrato errori transitori risolti.
- Revisione statica indipendente: nessun rilievo importante.

L'anteprima usa lo stesso componente della pagina Crea, senza login:
`http://127.0.0.1:4182/prototypes/first-work.html`.
Riavvio: `npm run dev:prototype` (Node disponibile nel PATH).

Installazione dipendenze: npm ha rilevato un conflitto peer preesistente;
`npx --yes bun install --frozen-lockfile` è riuscito con il lockfile del progetto.
Non è stata verificata una sessione autenticata dell'app né effettuato un deploy.
Il browser richiesto nel pannello Codex è stato accodato dal relativo tool.
