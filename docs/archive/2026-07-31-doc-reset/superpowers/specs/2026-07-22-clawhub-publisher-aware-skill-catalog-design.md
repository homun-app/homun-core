# Design — Catalogo skill ClawHub publisher-aware

Data: 2026-07-22. Corregge il caso reale in cui ClawHub contiene piu' skill con
lo stesso `slug` pubblicate da owner diversi. Serve il caposaldo #7: il catalogo
resta l'unico ingresso delle skill esterne, ma usa un'identita' non ambigua e
verificabile prima dell'installazione.

## Problema

Il catalogo Homun usa oggi il solo `slug` come identita' remota. Cercando
`weather`, il feed popolare di ClawHub espone una voce senza publisher, mentre
l'endpoint di download trova tre pacchetti distinti:

- `@steipete/weather`;
- `@legionspace-hackathon/weather`;
- `@lfengwa2/weather`.

La richiesta `GET /api/v1/download?slug=weather` risponde quindi `409
AMBIGUOUS_SKILL_SLUG` e richiede `ownerHandle`. Homun scarta il body della
risposta, mostra soltanto `download weather: HTTP 409 Conflict` e non offre un
modo per scegliere la skill corretta.

## Decisione

**Nei risultati di ricerca ogni combinazione `ownerHandle + slug` e' una voce
distinta.** Cercando `weather`, l'utente vede tutte le varianti direttamente
nell'elenco, con publisher visibile, e anteprima/installazione mantengono quella
stessa identita' fino al download.

Il catalogo iniziale senza query continua a usare il feed popolare cached, che
non espone il publisher. Quando esiste una query testuale, il gateway usa
`GET https://clawhub.ai/api/v1/search?q=...`, che restituisce tutte le varianti
con `ownerHandle`. Se la ricerca remota non e' raggiungibile, Homun ricade sulla
ricerca della cache esistente: il browsing resta disponibile, ma non inventa un
publisher.

## Identita' e modello dati

`CatalogEntry` viene esteso con campi opzionali:

```rust
struct CatalogEntry {
    slug: String,
    owner_handle: Option<String>,
    owner_name: Option<String>,
    name: String,
    description: String,
    downloads: u64,
    stars: u64,
    category: String,
}
```

- **Identita' remota/UI:** `@{owner_handle}/{slug}` quando l'owner e' noto;
  fallback al solo `slug` per le voci legacy del feed popolare.
- **Identita' locale:** resta il solo `slug`, quindi puo' essere installato un
  solo publisher per slug. Non si introducono directory namespaced ne' una
  seconda semantica per `use_skill("weather")`.
- **Provenance:** una nuova installazione salva
  `clawhub:@{owner_handle}/{slug}` in `skills-origins.json`; le origini storiche
  `clawhub:{slug}` restano leggibili e vengono trattate come publisher ignoto.

Questa separazione evita sia l'ambiguita' remota sia una migrazione distruttiva
degli ID locali gia' usati dal modello e dagli script.

## Backend

### Ricerca

`skills_catalog.rs` aggiunge i wire type per `/api/v1/search` e una funzione
`search_remote(http, query, limit)`. La normalizzazione:

1. conserva ogni risultato, anche quando piu' elementi hanno lo stesso `slug`;
2. legge `ownerHandle` e `owner.displayName`;
3. deriva la categoria con il classificatore esistente;
4. ordina secondo il ranking gia' restituito da ClawHub;
5. applica l'eventuale filtro categoria senza collassare i publisher.

`GET /api/skills/catalog` usa:

- query vuota: cache/feed popolare corrente;
- query non vuota: ricerca remota publisher-aware;
- errore della ricerca remota: fallback alla cache locale.

I conteggi categoria e il totale generale continuano a provenire dalla cache
del feed popolare. Non rappresentano il numero di publisher duplicati e la UI
non li presenta come tale.

### Anteprima e installazione

I contratti diventano:

```text
GET  /api/skills/catalog/preview?slug=weather&owner_handle=steipete
POST /api/skills/catalog/install
     { "slug": "weather", "owner_handle": "steipete" }
```

`owner_handle` resta opzionale per compatibilita' con le voci del feed popolare
e con client precedenti. Quando presente, `download_zip` invia sia `slug` sia
`ownerHandle` a ClawHub. Entrambi i componenti sono validati e URL-encoded.

Il gateway conserva il body testuale degli errori HTTP del download entro un
limite piccolo. Un eventuale `409` legacy mostra quindi la causa ClawHub e invita
a cercare lo slug per vedere i publisher, invece del solo status code.

### Collisione locale

La directory destinazione resta `~/.homun/skills/{slug}`:

- stessa origine `clawhub:@owner/slug`: la voce e' gia' installata;
- stesso slug con origine diversa o ignota: la voce e' in conflitto;
- slug libero: installazione normale, con provenance completa.

Non viene aggiunta in questa slice una sostituzione automatica: cambiare
publisher richiede rimuovere consapevolmente la skill installata. Il catalogo
non sovrascrive mai codice locale.

## UI

Ogni card dei risultati di ricerca mostra:

- nome skill;
- `@ownerHandle` e, se disponibile, display name del publisher;
- descrizione e metadati gia' presenti.

La key React, lo stato `busy` e il target dell'anteprima usano l'identita'
`ownerHandle + slug`, non il solo slug. In questo modo installare o aprire una
delle tre `weather` non anima o apre la card sbagliata.

Lo stato installazione distingue:

- **Installed:** provenance esatta uguale alla card;
- **Slug occupied:** esiste lo stesso ID locale, ma da altro publisher o da
  origine ignota;
- **Install:** nessuna collisione.

L'anteprima resta accessibile anche per una variante in conflitto, cosi'
l'utente puo' confrontarne contenuto e security report. Il pulsante Install e'
disabilitato con spiegazione esplicita finche' lo slug locale e' occupato.

Le immagini avatar remote non vengono caricate: la CSP desktop resta chiusa e
la card usa l'iniziale/identita' testuale gia' coerente con Settings.

## Gestione errori

- ricerca ClawHub irraggiungibile: fallback alla cache locale e nota non
  bloccante;
- publisher assente su una voce popolare: contratto legacy invariato;
- `409 AMBIGUOUS_SKILL_SLUG` senza owner: messaggio ClawHub leggibile e invito a
  cercare lo slug;
- owner non valido: `400 invalid_owner_handle` prima di qualunque chiamata;
- download con owner inesistente: errore upstream visibile, nessuna directory
  parziale;
- collisione locale: `409 skill_exists`, nessuna sovrascrittura;
- estrazione fallita: cleanup della directory destinazione come oggi.

## Testing

### Rust

- parsing di una risposta `/search` con tre risultati `slug=weather` conserva
  tre `CatalogEntry` e tre owner distinti;
- la normalizzazione mantiene ranking, categoria e campi publisher;
- la costruzione del download include `ownerHandle` quando presente e resta
  retrocompatibile quando assente;
- il body di un errore `409` viene preservato nel messaggio bounded;
- provenance esatta, publisher diverso e origine legacy producono i tre stati
  attesi;
- i test esistenti di cache/search locale restano verdi.

### UI

- tre varianti con lo stesso slug producono tre card/key distinte;
- preview e install ricevono l'owner corretto;
- `busy` interessa solo la variante selezionata;
- badge Installed solo per provenance esatta;
- publisher diverso mostra Slug occupied e non invia install;
- `npm run test:ui-contract`, typecheck e build restano verdi.

### Smoke live

1. cercare `weather` nel catalogo;
2. verificare le tre card con publisher distinti;
3. aprire `@steipete/weather` e verificare anteprima/security scan;
4. installarla e verificare origine `clawhub:@steipete/weather` nelle skill
   attive;
5. verificare che le altre due varianti risultino in conflitto, non installate.

## Non-goal

- Installare contemporaneamente piu' publisher con lo stesso slug.
- Scegliere automaticamente il primo publisher restituito da ClawHub.
- Caricare avatar remoti o allargare la CSP.
- Ridisegnare tassonomia, ranking o cache generale del catalogo.
- Aggiungere update/sostituzione automatica delle skill installate.
