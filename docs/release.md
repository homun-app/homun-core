# Release — pipeline di pubblicazione (adattata da homun-core)

Le release si costruiscono **in CI**, non in locale. Questa pagina descrive la
pipeline, i segreti e come verificare una build.

## Come funziona

`.github/workflows/build.yml` ("Build installers"):
- **Push di un tag `v*`** → il tag (senza la `v`) viene stampato in
  `apps/desktop/package.json` (fonte unica della versione), l'installer macOS
  arm64 viene firmato + notarizzato e pubblicato con i metadati di
  auto-aggiornamento (`latest-mac.yml`) in una **release draft sul repo
  pubblico `homun-app/homun-releases`** — che è anche il feed di
  electron-updater. La draft non è visibile finché non la pubblichi.
- **Esecuzione manuale** (Actions → *Build installers* → *Run workflow*)
  → build **non firmata** solo artifact: serve a provare la pipeline senza
  taggare.
- **PR su main** → come il manuale: validazione di build non pubblicante.

> **Un tag senza `MAC_CSC_LINK` fallisce di proposito.** Il passo di rilevamento
> delle credenziali esce con errore su un run `v*` senza certificato: una build
> macOS non firmata non può mai raggiungere il feed di aggiornamento pubblico.

Ogni runner costruisce il **proprio motore Python** (bundle PyInstaller
verificato da receipt, dipendenze hash-lockate via uv) e lo include
nell'installer. La firma copre anche i binari del motore ( entitlements
minimi, firmati in `after-pack` prima della firma dell'app).

## Segreti (ereditati dal repo, già configurati)

| Secret | Usato come | Scopo |
|---|---|---|
| `MAC_CSC_LINK` | `CSC_LINK` | Certificato Developer ID Application (`.p12` base64) |
| `MAC_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` | Password del `.p12` |
| `APPLE_ID` | `APPLE_ID` | Notarizzazione (Apple ID) |
| `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` | Notarizzazione |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` | Notarizzazione |
| `RELEASES_TOKEN` | `GH_TOKEN` (solo passo di publish) | Pubblicazione su `homun-app/homun-releases` |

Windows/Linux non sono ancora in pipeline: il motore è verificato solo su
macOS arm64 (vedi `docs/research/` per il piano piattaforme).

## Taggare una release

1. La sezione `## [x.y.z] — data` deve esistere in `CHANGELOG.md`: la build
   fallisce senza note (mai una release senza changelog).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Attendi la build firmata; controlla la draft su `homun-releases`
   (installer, `SHA256SUMS-mac.txt`, note dal CHANGELOG).
4. Prova il dmg su un Mac pulito (Gatekeeper), poi pubblica la draft: da quel
   momento è il feed di aggiornamento.

## Verifica locale (senza firma)

```sh
python3 tools/build_engine_bundle.py   # dist/engine
npm run build                          # apps/web/dist
cd apps/desktop && npm ci
npm run release:prepare                # .package/ verificato
npx electron-builder --mac --publish never -c.mac.identity=null
npm run release:verify -- "$(find dist-installers -maxdepth 3 -type d -iname Homun.app -print -quit)" --expected-arch arm64
```

L'updater (macOS) è attivo solo nell'app packaged: propone il download, mai
l'installazione silenziosa; l'installazione avviene alla chiusura.
