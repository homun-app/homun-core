# File del run e consegne scaricabili

Obiettivo H11: il modello elenca e legge i file del proprio workspace terminale,
poi consegna snapshot immutabili scaricabili. Non esporre percorsi host arbitrari.
Nuovi run fissano il toolset; run esistenti non acquisiscono strumenti.

File IO dedicato: percorsi relativi, componenti senza symlink, openat/dirfd,
O_NOFOLLOW e O_NONBLOCK, soli file regolari senza hardlink, lettura limitata,
verifica stat prima/dopo. Elenco limitato con segnale di incompletezza. Lettura
UTF8 paginata e metadati/hash per binari. Max 25 MiB come ingest esistente.

Consegna: require authority del run prima e dopo lettura, SHA256 atteso obbligatorio,
archivio managed_blobs esistente con il suo lock, CommandRecord work.output che
lega work/run/call/path/hash/size. Ripresa della stessa chiamata restituisce la
receipt salvata anche se il file di lavoro cambia. Recovery materiali include
questi riferimenti. Download autenticato con controllo hash, attachment e nosniff;
file mai eseguiti o aperti inline. Questa consegna non equivale a review approvata.

- [x] RED IO: traversal/symlink/FIFO/hardlink/mutation/size, UTF8 e binari.
- [x] Toolset nativo versione fissata, elenco/lettura/consegna con receipt persistente.
- [x] API elenco/download output e UI nel lavoro; nessuna simulazione di file.
- [x] Test authority/replay/recovery, prova Docker/modello, review e verifiche.
- [x] Docs, commit e merge locale. H11 completo resta aperto (scrittura/patch/LSP).
