# Homun 2

Nuova base di Homun: interfaccia React, applicazione installabile Electron e motore Python accessibile tramite API. Il futuro client Flutter potrà utilizzare le stesse API.

## Struttura

- `apps/web/`: nuova interfaccia React; attualmente conserva la simulazione del prototipo.
- `apps/desktop/`: spazio dedicato alla shell Electron e alla distribuzione installabile.
- `engine/`: spazio dedicato al motore Python.
- `packages/ui/`: componenti React condivisi.
- `contracts/`: confine API e futuri contratti generati.
- `prototypes/`: prototipi navigabili e copia autonoma dei sorgenti di riferimento.
- `docs/specifications/`: requisiti di prodotto, agenti, settings, permessi e API.
- `docs/development/`: piano di sviluppo e passaggio dal vecchio Homun.
- `tests/`: verifiche della logica attuale.

## Avvio locale

Usare npm e Node 24 o successivo. Installare con `npm ci`. `.npmrc` conserva la compatibilità con i peer dependency del template storico; riallinearli prima della fase release.

- `npm run dev`: nuova app su http://127.0.0.1:4183.
- `npm run dev:prototype`: riferimento su http://127.0.0.1:4182.
- `npm run check`: TypeScript, test, build app e build prototipi.

La separazione dei sorgenti permette di evolvere la nuova app conservando il riferimento UX. Le due versioni condividono per ora dipendenze e risorse pubbliche. I vecchi collegamenti ai sorgenti `src/` nella documentazione storica corrispondono ora a `prototypes/reference/src/`; il codice destinato alla nuova app è in `apps/web/src/`.

## Stato reale

L'interfaccia è ancora una simulazione locale. Motore Python, connessioni reali, shell Electron, installer, firma e aggiornamenti non sono implementati in questo bootstrap. Le dipendenze storiche Supabase/TanStack restano per il riferimento e non costituiscono una scelta per il nuovo backend.

La versione esistente in `../app` resta indipendente. La sostituzione avverrà secondo `docs/development/transizione-homun.md`. Nessuna pubblicazione automatica è configurata. Rispettare le istruzioni Lovable di `AGENTS.md` senza riscrivere storia pubblicata.
