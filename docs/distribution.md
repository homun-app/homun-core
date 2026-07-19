# Distribuzione — installer multipiattaforma

Gli installer di Homun sono prodotti **automaticamente da GitHub Actions**
([`.github/workflows/build.yml`](../.github/workflows/build.yml)) su tre runner
nativi:

| Piattaforma | Runner        | Arch  | Output                       | Firma                          |
| ----------- | ------------- | ----- | ---------------------------- | ------------------------------ |
| macOS       | `macos-14`    | arm64 | `.dmg` + `.zip`              | Developer ID + notarizzazione¹ |
| Windows     | `windows-latest` | x64 | `.exe` (NSIS)                | nessuna (vedi sotto)           |
| Linux       | `ubuntu-22.04`| x64   | `.AppImage` + `.deb`         | nessuna (standard)             |

Ogni runner **ricompila il proprio gateway** (`cargo build --release`) e lo
incapsula nell'app: un installer è valido solo per la coppia OS/arch che l'ha
prodotto. Niente database, immagini Docker o dati nel pacchetto — l'app ricrea
tutto al primo avvio in `~/.homun/`.

¹ La firma+notarizzazione macOS si attiva **solo quando i secret sono
configurati** (vedi sotto). Finché non lo sono, anche il build macOS gira ma
**non firmato**, così la pipeline non fallisce.

## Come si rilascia

1. Verifica il commit esatto di `main` che deve essere rilasciato.
2. Crea e pusha un tag che inizia con `v`:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Il workflow usa il tag come fonte autoritativa della versione e la applica
   automaticamente a `apps/desktop/package.json` durante la build.
4. Il workflow builda le tre piattaforme e crea una **GitHub Release in bozza**
   con gli installer allegati. Controlli gli asset e poi la pubblichi a mano.

Per **provare la pipeline senza rilasciare**: Actions → "Build installers" →
*Run workflow* (`workflow_dispatch`). Builda e carica gli artifact, senza creare
release.

> Nota: il repo è privato, quindi ogni run consuma minuti Actions a pagamento
> (3 runner in parallelo). Il workflow **non** parte su ogni push: solo su tag
> `v*` o avvio manuale.

## Firma macOS — secret da configurare

Servono **5 secret** del repository (Settings → Secrets and variables → Actions).
Una volta presenti, il prossimo build macOS sarà firmato Developer ID **e**
notarizzato; senza, resta non firmato.

| Secret                        | Cos'è                                                                 |
| ----------------------------- | --------------------------------------------------------------------- |
| `MAC_CSC_LINK`                | certificato **Developer ID Application** in `.p12`, codificato base64  |
| `MAC_CSC_KEY_PASSWORD`        | password del `.p12`                                                    |
| `APPLE_ID`                    | la tua Apple ID (email)                                               |
| `APPLE_APP_SPECIFIC_PASSWORD` | password app-specific da [appleid.apple.com](https://appleid.apple.com) → Sicurezza |
| `APPLE_TEAM_ID`               | Team ID di 10 caratteri (Apple Developer → Membership)                |

Esportare il certificato in base64 (dal Mac dove hai il Developer ID nel
portachiavi → esporta in `cert.p12`):

```bash
base64 -i cert.p12 | pbcopy   # incolla il risultato come valore di MAC_CSC_LINK
```

> Il `Developer ID Application` (non "Mac App Distribution") è il certificato
> giusto per distribuire **fuori** dal Mac App Store.

## Windows — installer non firmato

Non abbiamo (ancora) un certificato Authenticode, quindi l'`.exe` NSIS è **non
firmato**. Conseguenza pratica: al primo avvio Windows mostra il SmartScreen
("Windows ha protetto il PC") → *Ulteriori informazioni* → *Esegui comunque*.

Per firmarlo in futuro servirebbe un certificato Code Signing (OV o, meglio, EV
su token hardware) da una CA; poi si aggiungerebbe uno step `signtool` o le
opzioni di firma di electron-builder nel job Windows. Per ora: nessun blocco,
solo l'avviso.

## Build locale (per test)

Dalla cartella `apps/desktop`:

```bash
npm run dist     # package:prepare (vite + gateway release) + electron-builder per l'OS corrente
```

Gli installer finiscono in `apps/desktop/dist-installers/` (gitignored). In
locale **non** viene notarizzato (manca l'env Apple); se hai un Developer ID nel
portachiavi viene firmato, altrimenti no.

## Limiti noti / follow-up

- **Mac Intel (x64)**: non prodotto. Il runner `macos-14` è Apple Silicon e il
  gateway è arm64. Per supportare gli Intel serve un build x64 separato
  (cross-compile del gateway o runner x64) → da aggiungere se richiesto.
- **Linux/Windows arm64**: non prodotti (solo x64), stessa ragione.
- **pdfium**: l'ingestione PDF degli allegati si lega a `pdfium` a runtime via
  `libloading`. Verificare che la dylib sia disponibile nell'app pacchettizzata
  (oggi `package:prepare` copia solo il binario del gateway) — altrimenti
  l'estrazione testo dei PDF degrada. Da bundlare in `extraResources` se serve.
- La pipeline va verificata con un primo run reale (build win/linux non
  riproducibili in locale su macOS); attendersi 1–2 iterazioni di rifinitura.
