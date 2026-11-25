# FATTO — la definizione di «fatto», uguale per ogni fase

Le spec delle fasi citano questo documento invece di riscriverlo: «una fase è finita quando
`scripts/fatto.mjs` è verde» — e quando è verde per davvero, non a memoria: i numeri del REPORT
vengono dalla corsa fatta **DOPO l'ultimo commit di codice** (nessun numero dichiarato a banco,
nessuna corsa prima dell'ultimo commit).

`scripts/fatto.mjs [--sonde fase-x,fase-y]` esegue i punti 1–7 **uno alla volta** (mai due insieme),
salva l'uscita completa di ogni passo in un file e scrive esito, durata e percorso in
`fatto-esito.md` (in `.gitignore`, alla radice del repo).

1. **typecheck** — `tsc --noEmit` senza errori.
2. **suite** — `npm test` e `npm run test:ci-sim` verdi, **anche con il Docker Desktop dell'utente
   che non risponde** (la guardia dei sandbox lo rende irraggiungibile per costruzione, non è un
   motivo per saltare o per ritoccare a mano i test).
3. **build** — `electron-vite build` diretto (senza hook che scrivono in `vendor/`) senza errori.
4. **galleria** — `node scripts/galleria.mjs` senza differenze, oppure differenze approvate in un
   commit con l'elenco delle scene e il motivo.
5. **sonde** — le sonde di comportamento della fase (quelle in `--sonde`), **una alla volta**, con
   l'uscita su file. Le sonde girano **una volta** a verifica. La stabilità di una sonda si prova
   una volta sola, quando la sonda nasce o si converte al motore (`scripts/lib/sonda.mjs`): **tre
   corse di fila verdi**, e quella prova sta nel REPORT della fase che la tocca. Le sonde di
   comportamento delle fasi vecchie **non si rifanno** a ogni fase: la galleria e la suite coprono
   la regressione; si rifanno solo quelle dell'area toccata dalla fase.
6. **processi a 0** — processi Electron e `--homun-daemon` DEL REPO, contati per eseguibile
   (`ps -axo pid=,comm=`): 0 e 0.
7. **temporanei a 0** — la corsa ha una radice sua (una `fatto-*` con mkdtemp nella base dei vincoli,
   passata come `TMPDIR` a tutti i passi): a fine corsa dev'essere **vuota**, e poi si cancella. Nella
   `T/` comune conta solo ciò che porta un prefisso del repo (`sandbot-*`, `fatto-*`: tutto ciò che il
   codice crea, letto dal codice): ogni cartella NUOVA di quei prefissi, rispetto alla fotografia
   presa prima del passo 1, è un errore. Il resto — le cartelle delle altre app — non conta: un
   controllo che fallisce per colpa altrui insegna a ignorarlo.

Non coperti da `fatto.mjs` (la spec della fase li porta, e la chiusura li controlla):

8. le catture e le misure delle altre fasi riportate a HEAD (`git status` pulito su `docs/`);
9. il REPORT con la sezione della fase **in cima** e la **coda byte-identica**, il CHANGELOG
   invariato, il tag annotato della fase, nessun push, nessun tag `v*`.

Regola per i componenti: **un componente nuovo in `src/renderer/src/components/ui/` entra nella
pagina dei componenti (F2) con tutti i suoi stati**, in chiaro e in scuro; la guardia
(`src/__tests__/guardie/componenti.test.ts`) fallisce se un file di `components/ui/` non è
importato dalla pagina. Le scene nuove della galleria hanno la loro immagine approvata prima di
entrare in una fase che la tocca.
