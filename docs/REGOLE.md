# REGOLE — l'elenco unico delle regole e delle loro guardie

Ogni regola che si può controllare dal codice ha una GUARDIA: un test che
fallisce da solo quando la regola è violata. Le regole stanno qui, non nei
prompt. Le eccezioni vivono nel file della guardia, ognuna col suo perché.

| regola | perché | guardia (file del test) | eccezioni |
|---|---|---|---|
| Il testo visibile del renderer usa SOLO le sei dimensioni (12, 13, 14, 16, 20, 28 px) e i pesi 400/500/600 | la scala di DS1: le pagine non inventano misure | `src/__tests__/guardie/design-guard.test.ts` | le eccezioni vivono in `src/renderer/src/lib/design-exceptions.ts`, ognuna col motivo |
| Le classi del renderer non scrivono px arbitrari (text-[…], p-[…], gap-[…], rounded-[…], w-[…px], uppercase, leading-…) | i token decidono; una misura a mano sfugge al tema | `src/__tests__/guardie/design-guard.test.ts` | idem |
| Le icone lucide sono da 16 px (size-4) o 20 px (size-5), la misura è scritta | la misura visiva delle icone è parte del design | `src/__tests__/guardie/design-guard.test.ts` | idem |
| Nessuna emoji nell'interfaccia | le icone sono lucide; un'emoji non segue il tema | `src/__tests__/guardie/design-guard.test.ts` | idem |
| I token di styles.css e le classi generate stanno allineati (nessuna classe morta) | il CSS compilato è l'unica verità della vista | `src/__tests__/guardie/design-tokens.test.ts` | — |
| L'anello di fuoco SOLO su `:focus-visible` | mai un anello dopo il clic del mouse | `src/__tests__/guardie/focus-ring-guard.test.ts` | — |
| La t dei .tsx viene da `useLingui()` (il hook) e i testi visibili sono avvolti | i cataloghi non mentono; il testo grezzo non è traducibile | `src/__tests__/guardie/unwrapped-text-guard.test.ts` | la pagina dei componenti (F2): i suoi testi sono di TEST, non entrano nei cataloghi |
| I dialoghi di scelta (Dialog) non scendono sotto le misure DS3 | un dialogo più stretto della scala non è leggibile | `src/__tests__/guardie/dialog-width-guard.test.ts` | — |
| Il menu delle skill si apre dai pezzi giusti del pannello | la voce di menu che sparisce rompe la pagina | `src/__tests__/guardie/skills-menu-guard.test.ts` | — |
| docs/DESIGN.md (F4) è coerente col codice: ogni token di styles.css c'è con lo stesso valore, e ogni componente di components/ui/ ha la sua voce | la documentazione che mente è peggiore di quella assente | `src/__tests__/guardie/design-doc.test.ts` | — |
| Nessuna MISURA CRUDA nelle classi del renderer (h-[52px], min-h-[44px], top-[13px]…) fuori dalle eccezioni | le altezze e le posizioni che design-guard non vede | `src/__tests__/guardie/misure-crude.test.ts` | i passi della guida (GuideModelStep, GuideComputerStep, GuideView): misure volute di quella fase, elencate nel REPORT |
| Nessun COLORE scritto a mano nei .tsx del renderer (#…, rgb(, oklch() | i colori stanno in styles.css e seguono il tema | `src/__tests__/guardie/colori-crudi.test.ts` | la mascotte della boot-splash (colori fisici del disegno) e i fallback di xterm (letterali richiesti da xterm, token prima) |
| Nessun percorso personale nel sorgente (mai `/Users/<nome>` diverso da test) | la home di chi scrive non sta nel repo; le fixture sono neutre | `src/__tests__/guardie/percorsi-personali.test.ts` | scripts/copia-fixture-container-1.7.1.mjs (la radice che RIPULISCE è il formato dei file fixture) e la guardia stessa |
| I test creano le temporanee SOLO dall'aiutante `src/test-tmp.ts` (TEST_TMP_BASE) | nessun test decide la base da sé: la fotografia di fatto.mjs vale per tutti | `src/__tests__/guardie/temporanei.test.ts` | test-setup.ts, test-tmp-guard.ts, test-tmp.ts e i test che li verificano |
| Nessuna porta dei modelli veri (11434, 1234) nei test e nelle sonde | mai toccare Ollama/LM Studio della macchina: solo 127.0.0.1 con porte libere | `src/__tests__/guardie/porte-modelli.test.ts` | i test che verificano PROPRIO di non toccarle (local-model-server, fase-impostazioni-probe) |
| La pagina dei componenti (F2) non entra nel build: nessun marcatore in out/ | la pagina è solo di sviluppo e di test | `src/__tests__/guardie/componenti.test.ts` | — |
| Ogni componente di components/ui/ è nella pagina dei componenti con i suoi stati | un componente nuovo entra nella pagina con tutti gli stati (docs/FATTO.md) | `src/__tests__/guardie/componenti.test.ts` | — |
| Il Docker vero non si tocca nei test (la CLI `container` è irraggiungibile per costruzione) | il Docker Desktop dell'utente può non rispondere: la suite è verde lo stesso | `src/test-setup.ts` (HOMUN_CONTAINER_PATH → un percorso inesistente) e `src/main/sandbox/__tests__/docker-argv.test.ts` | — |
| Le temporanee dei test non restano a terra a fine corsa | la macchina resta pulita: ogni residuo è una corsa rossa | `src/test-tmp-guard.ts` (globalSetup) | — |
| Le sonde convertite o nuove usano il motore `scripts/lib/sonda.mjs` e non hanno `sleep(` fissi | un'attesa fissa è lenta se la condizione arriva prima, falsa se arriva dopo | la guardia dei sleep sta in `scripts/__tests__/aiutanti-probe-guard.test.ts` e nelle prossime fasi (le sonde convertite vengono girate a ogni fase che le tocca) | le attese che misurano un tempo DI PROPOSITO, col commento |
