# Release Candidate Matrix

Questa matrice e' il gate tra "GitHub ha prodotto gli installer" e "la release e'
scaricabile". Una riga rossa o non verificabile lascia la release in **draft**.

## 1. Identita' del candidato

Registrare prima di iniziare:

| Campo | Valore richiesto |
|---|---|
| Source SHA | `git rev-parse HEAD` |
| Branch CI | URL del run CI verde sullo stesso SHA |
| Readiness run | URL di `Build installers` sullo stesso SHA |
| Versione proposta | maggiore dell'ultima release pubblica |
| Profilo test | directory isolata, mai `~/.homun` reale |

Verifica iniziale:

```bash
git status --short
python3 scripts/pre_release_gate.py
cargo audit
npm --prefix apps/desktop audit --audit-level=high
```

Il worktree deve essere pulito e tutti i comandi devono terminare con codice `0`.

## 2. Build multipiattaforma non pubblica

Prima del tag, eseguire il workflow sul commit candidato:

```bash
gh workflow run build.yml --repo homun-app/homun-core --ref <candidate-branch>
gh run list --repo homun-app/homun-core --workflow build.yml --limit 1
gh run watch <run-id> --repo homun-app/homun-core --exit-status
mkdir -p output/release-candidate/<run-id>
gh run download <run-id> --repo homun-app/homun-core --dir output/release-candidate/<run-id>
```

Il run e' accettabile soltanto se `Release readiness`, `Build (mac)`,
`Build (win)` e `Build (linux)` sono verdi. Ogni artifact deve contenere il
manifest corrispondente:

- `SHA256SUMS-mac.txt` con DMG e ZIP;
- `SHA256SUMS-win.txt` con EXE;
- `SHA256SUMS-linux.txt` con AppImage e DEB.

Da ciascuna directory artifact:

```bash
shasum -a 256 -c SHA256SUMS-<platform>.txt
```

Ogni riga deve risultare `OK`. Questo dispatch non crea una release pubblica.

## 3. Profilo di upgrade isolato

Creare un profilo con l'ultima release pubblica usando solo dati di test:

```bash
export HOMUN_RC_PROFILE="$(mktemp -d /tmp/homun-rc-profile.XXXXXX)"
chmod 700 "$HOMUN_RC_PROFILE"
```

Avviare l'eseguibile dell'ultima release pubblica dal terminale, impostando
`HOMUN_DATA_DIR="$HOMUN_RC_PROFILE"`. Nel profilo isolato creare:

- due conversazioni, una completata e una con storico multi-turno;
- un'impostazione runtime non predefinita;
- un provider di test;
- una connessione o un connector disabilitato, senza credenziali di produzione;
- memoria personale e memoria progetto con contenuto sintetico;
- un record Vault sintetico protetto da PIN di test;
- un task completato e un approval risolto.

Chiudere l'app, copiare il profilo come baseline e avviare il candidato sullo
stesso `HOMUN_DATA_DIR`. Devono restare invariati o leggibili:

| Dominio | Evidenza richiesta |
|---|---|
| Database | apertura senza recovery error o migration parziale |
| Chat | entrambe le conversazioni e un solo messaggio per identita' |
| Task/journal | nessun task fantasma `running`; revisioni coerenti |
| Vault | metadati presenti; reveal solo dopo PIN; nessun plaintext nei log |
| Memoria | scope personale/progetto separati e richiamabili |
| Connessioni | configurazione presente; secret non esposto nel renderer |
| Runtime | sandbox e approval policy conservate |

Il profilo reale dell'utente non viene aperto, copiato o modificato durante
questa prova.

## 4. Contratti kernel sull'app candidata

Eseguire sulla build installata, non su Vite:

| Scenario | Criterio di accettazione |
|---|---|
| Turno semplice | un task, un terminale, un assistant canonico |
| Tre turni concorrenti | completamento in background senza cambiare selezione |
| HITL libero | stessa identita' turno; una sola revisione successiva al wake |
| Approval vincolante | nessun side effect prima della conferma |
| Cancellazione | task/run/message convergono a `cancelled`; nessun processo orfano |
| Gateway hard kill | lease recuperata; nessun terminale o assistant duplicato |
| Browser sidecar kill | checkpoint adottato oppure failure terminale esplicita |
| Effetto incerto | nessuna riesecuzione automatica; card Tasks presente |
| Risoluzione effetto | `applied`/`not_applied` seguito da rilettura canonica |
| Long-running | progresso/checkpoint persistiti; stop e resume deterministici |
| Sandbox | write fuori root negata su macOS/Linux; escalation esplicita |
| Vault | dati sintetici mai presenti in trace, log o payload renderer |

Per ogni scenario ricostruire task, execution journal, effect receipt, turn
events e messaggio. Un risultato visivamente corretto con stato persistito
discordante e' un fallimento.

## 5. Tag build e release draft

Solo dopo i punti 1-4 verdi, creare il tag. Il tag build deve lasciare la release
in draft nel repository `homun-app/homun-releases`. Prima della pubblicazione:

```bash
gh release view <tag> --repo homun-app/homun-releases \
  --json isDraft,assets,url
```

Verificare che `isDraft` sia `true`, che gli asset attesi e i tre manifest SHA-256
siano presenti e che non esistano nomi/versioni miste.

## 6. Firma e installazione macOS

Montare il DMG del draft e verificare l'app reale:

```bash
codesign -dv --verbose=4 "/Volumes/Homun/Homun.app"
codesign --verify --deep --strict --verbose=2 "/Volumes/Homun/Homun.app"
spctl --assess --type execute --verbose=2 "/Volumes/Homun/Homun.app"
xcrun stapler validate "/Volumes/Homun/Homun.app"
npm --prefix apps/desktop run verify:host-computer-package -- \
  --app "/Volumes/Homun/Homun.app" --expected-arch arm64
```

La firma deve essere Developer ID, Gatekeeper deve accettare, il ticket deve
essere stapled e il nested helper deve conservare firma, entitlement e architettura.

## 7. Pubblicazione

Prima di premere **Publish release**:

- nessun gate e' rosso, skipped senza motivazione o basato solo su sorgenti;
- il candidato installato ha superato upgrade e kernel matrix;
- release notes e versione corrispondono al tag;
- `v0.1.1079` e `v0.1.1093` non vengono promosse per errore;
- esiste un piano di ritorno alla release pubblica precedente.

Dopo la pubblicazione verificare pagina download, `latest*.yml`, rilevamento
aggiornamento da un client precedente e checksum scaricati. Fino a quel momento
la release resta invisibile al feed pubblico.
