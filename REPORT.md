# REPORT FASE MEMORIA-ENGRAMMA v0.4.3 — Homun passa a Engramma `fase-v0.4.3`

**Data:** 2026-11-09 · **Base:** `main` @ `a6aa41ee` (tag `fase-memoria-engramma-correzioni-2`) · **Tag di chiusura:** `fase-memoria-engramma-v043`. Nessun push. Lavoro offline; il repo di Engramma non toccato (né build del `.node`), `out-review/` intatta, nessuna cartella dati vera usata; temporanei solo in `/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/` e cancellati a fine fase.

**Verifica finale:** `typecheck` pulito · `vitest` **229 file / 3493 test verdi** (base: 229/3492 → +1 test lsof in `delete-agent.test.ts`; un test esistente aggiorna il pin del tag) · `npm run build` verde.

## Il lock, prima e dopo

**Prima (v0.4.2):**

```json
{
  "module": "engramma-node",
  "version": "0.1.0-dev",
  "tag": "fase-v0.4.2",
  "commit": "1afc00765c8573cc9a8c494a8c249894457475a5",
  "files": {
    "engramma.darwin-arm64.node": "14cd10d5cdf5c1091e6f5650b5b122d7d058fdeca570b1d541918b9f53d07c4a",
    "index.js": "25fd9cc1d50a1ec3f2d74bc004d904663ff07360102d27b938870329d9c832d4",
    "index.d.ts": "bf9381f18911d1fba6269eb745c2825c57f5ed643461d4c2a6488005bf69d9f8"
  }
}
```

**Dopo (v0.4.3):**

```json
{
  "module": "engramma-node",
  "version": "0.1.0-dev",
  "tag": "fase-v0.4.3",
  "commit": "bdb47871d3e28a5263e974cb6f4118dd4ed21bb3",
  "files": {
    "engramma.darwin-arm64.node": "b27b0b0726829c2f32f3934622e99e0d76d3a3e91bad657c3b05fd97038d771d",
    "index.js": "25fd9cc1d50a1ec3f2d74bc004d904663ff07360102d27b938870329d9c832d4",
    "index.d.ts": "bf9381f18911d1fba6269eb745c2825c57f5ed643461d4c2a6488005bf69d9f8"
  }
}
```

Cambia SOLO `engramma.darwin-arm64.node` (il contratto JS è lo stesso: `index.js` e `index.d.ts` hanno gli stessi hash). L'hash del `.node` nella sorgente (`~/Projects/Bot/engramma/crates/engramma-node/`, repo al tag `fase-v0.4.3`) è esattamente quello atteso dalla verifica (`b27b0b07…`): binario verificato, agganciato. Il `commit` nel lock è l'oggetto del tag annotato (`git rev-parse fase-v0.4.3` = `bdb4787…`), stesso formato della riga `1afc007…` di prima.

## V1 — Il lock passa a `fase-v0.4.3`

- **Prima di tutto** la copia di sicurezza: `vendor/engramma/engramma.darwin-arm64.node` (v0.4.2, hash `14cd10d5…` controllato) copiato in una temporanea con accanto `index.js` e `index.d.ts` — il binario non è in git e dopo il cambio di vendor non si recuperava più. Servita per la corsa rossa di V3, cancellata a fine fase.
- `node scripts/prepare-engramma.mjs --update-lock`, poi a mano nel lock: `tag` → `fase-v0.4.3`, `commit` → `bdb47871d3e28a5263e974cb6f4118dd4ed21bb3`.
- `vendor/engramma/` ora contiene il `.node` nuovo con l'hash del lock (`b27b0b07…` verificato). Percorso veloce controllato: `prepare-engramma` lanciato due volte, la seconda NON ha toccato nulla (mtime identici, «copiati (già presenti) — verificati 3/3»).
- Seguito necessario: `scripts/__tests__/prepare-engramma.test.ts` pina il tag del lock nel repo («tag fase-v0.4.2»): portato a `fase-v0.4.3`, visto fallire con l'attesa vecchia subito dopo il cambio del lock. Era l'unico posto fuori dal lock che nominava la fase.

## V2 — Il codice dice la verità sulla v0.4.3

Solo commenti in `src/main/memory/engine.ts`, nessuna modifica di comportamento:

- **`assertNoSnap` (~272):** il «difetto aperto» è chiuso — la v0.4.3 rifiuta da sola i nomi `<cella>-snap-<cifre>` (riservati, `INVALID_ARGUMENT`) e `cells()` non elenca le istantanee. L'asserzione di Homun **resta**: è più severa (vieta QUALSIASI `-snap-`, non solo la forma con cifre — l'id di un bot arriva da fuori e non si vuole dipendere dal predicato esatto del motore) e costa nulla.
- **`dropCellAndEvict` (~487):** resta vero che `NOT_FOUND` vale «già dimenticata» e che la cella va tolta da `state.cells` sempre; cambia il perché: dalla v0.4.3 `dropCell` chiude subito la connessione condivisa (`Cell::retire`), quindi lo sgombero della cache serve a **non riusare un handle sigillato** (una `Cell` in cache risponde `NOT_FOUND` per sempre), **non** a liberare il disco.
- **Coda dell'oblio (~605):** aggiunta la verità nuova: quando il job `memory-forget-agent` risponde, l'oblio è finito DAVVERO — nessun file cancellato resta aperto fino al GC.

Le altre menzioni di v0.4.2 nel codice (lapidi nel `list`, `pullModel` a caldo, il contratto `.d.ts` «fase-v0.4.2») dicono feature nate in quella versione e ancora vere: lasciate.

## V3 — L'oblio di un bot non lascia file aperti

Test nuovo in `src/main/store/__tests__/delete-agent.test.ts`, sul percorso vero del demone (come R2): bot con memoria in `bot-<id>` (`writeMemoryNote`) e conversazione indicizzata in `storia-<id>` (`indexStoryNote`); **prima dell'oblio** una ricerca su entrambe le celle (`recallMemories` su `bot-<id>`, `searchHistory` su `storia-<id>`: le `Cell` finiscono nella cache del motore e in quella di Homun); poi `deleteAgent` + job `memory-forget-agent` col runner vero (`makeJobRunner`). Quindi `lsof -p <pid del processo di test>`: **nessuna riga** su `bot-<id>.sqlite*` e `storia-<id>.sqlite*`, senza `gc()`. Prima dell'oblio il test verifica anche che i file siano APERTI (il controllo non è vacuo: li ha visti in entrambe le corse). Se `lsof` manca, il test si salta esplicito (`it.skipIf`).

**Rosso con il `.node` della v0.4.2** (`SANDBOT_ENGRAMMA_DIR` puntato alla copia messa da parte in V1) — 10 righe sopravvissute al job dell'oblio, trascritte dalla corsa:

```
node    12778 fabio  txt      REG               1,17     32768           169077574 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/bot-agent_e10eabd3.sqlite-shm
node    12778 fabio  txt      REG               1,17      4096           169077571 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/bot-agent_e10eabd3.sqlite
node    12778 fabio  txt      REG               1,17     32768           169077578 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/storia-agent_e10eabd3.sqlite-shm
node    12778 fabio  txt      REG               1,17      4096           169077575 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/storia-agent_e10eabd3.sqlite
node    12778 fabio   22u     REG               1,17      4096           169077571 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/bot-agent_e10eabd3.sqlite
node    12778 fabio   23u     REG               1,17    333752           169077573 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/bot-agent_e10eabd3.sqlite-wal
node    12778 fabio   24u     REG               1,17     32768           169077574 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/bot-agent_e10eabd3.sqlite-shm
node    12778 fabio   25u     REG               1,17      4096           169077575 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/storia-agent_e10eabd3.sqlite
node    12778 fabio   26u     REG               1,17    333752           169077577 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/storia-agent_e10eabd3.sqlite-wal
node    12778 fabio   27u     REG               1,17     32768           169077578 /private/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-delagent-Fn0aBz/mem-v043/memory/cells/storia-agent_e10eabd3.sqlite-shm
```

Sono i `.sqlite`, `-wal` e `-shm` di ENTRAMBE le celle, ancora aperti dopo il job: la `Cell` nella cache del motore (Homun la sua la sgombera già da `dropCellAndEvict`) teneva la connessione fino al GC — l'oblio «finiva ore dopo».

**Verde con la v0.4.3** (vendor corrente): stesso test, `lsof` vuoto, celle scomparse da `engine.cells()`. `AssertionError: expected [ …(10) ] to deeply equal []` nella corsa rossa, 5/5 test del file verdi nella verde.

## Chiusura

- `typecheck` pulito, `vitest` 229 file / 3493 test verdi, `npm run build` verde. Nessun timeout da rilanciare.
- `release:local` e `release:verify` **non eseguiti**: offline, `fetch-llama` vuole la rete (come già dichiarato nella fase L, il bundle llama.cpp non è mai stato scaricato). Non aggirato.
- Commit: `224d090` (V1 lock) · `b33dd9b` (V2 commenti) · `9d1ccd4` (V3 test) · `d898313` (V1 seguito: pin del test del lock) · REPORT. Tag `fase-memoria-engramma-v043` sul commit del REPORT. Nessun push.
- Temporanei in `/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/` cancellati (copia del `.node` v0.4.2 e file segna-percorso).
