# Verifica browser: piè di pagina della ricerca rimosso (2026-10-12)

Branch `fix/search-footer-removal`. Motore reale su `HOMUN_DATA_DIR` temporaneo
(`/tmp/homun-search-verify.*`, mai i dati in `~/Library/Application Support/`),
progetto «Verifica ricerca» con materiale «Listino fornitori» seminati via API.

Quattro scenari, screenshot in `assets/2026-10-12-search-footer-removal/`:

1. **Motore acceso** (`01-motore-attivo-ricerca-senza-footer.png`): ⌘K con
   risultati (materiale + progetto), nessun `<footer>`, nessun avviso.
2. **Motore fermo, zero risultati** (`02-motore-fermo-stato-vuoto-con-motivo.png`):
   stato vuoto «Nessun risultato. I materiali non sono raggiungibili in questo
   momento.» con il motivo tipizzato («App locale non raggiungibile. Avviala o
   riprova.»); lo stato globale del motore resta al solo banner del workspace.
3. **Materiali irraggiungibili, altre fonti ok**
   (`03-materiali-irraggiungibili-riga-in-cima.png`): motore acceso, risposta
   503 `storage_unavailable` simulata dal browser SOLO sulle richieste
   `GET …/materials` della sonda; una riga discreta in cima ai risultati
   («Alcuni materiali mancano: Il salvataggio non è disponibile…»), risultati
   presenti, banner silente (motore sano).
4. **Simulazione** (`04-simulazione-indicatore-unico.png`): l'etichetta
   «Fonte: simulazione — nessun dato reale è collegato.» compare una volta
   sola, nell'interfaccia principale (banner via
   `ConversationWorkspaceEngineNotices`); la ricerca non ripete nulla. In
   modalità motore l'etichetta non esiste.

Regressioni inchiodate nei test: `tests/conversation-search.test.ts` (nessun
footer; stato vuoto con motivo; riga in cima; fonti sane → nessun avviso;
simulazione senza avvisi motore) e `tests/engine-operational-notices.test.ts`
(indicatore unico presente in simulazione, assente in modalità motore).
