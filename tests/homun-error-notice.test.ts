/**
 * «Dettagli tecnici» negli errori, verificati sul rendering reale del
 * componente (grafo vite dell'app, senza browser).
 *
 * Invariante: il testo principale è sempre copia di prodotto; codice,
 * messaggio originale e codice del motore vivono solo nel blocco
 * `<details>` chiuso di default, con copia come testo semplice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { componentRenderer } from "./helpers/render-component.ts";
import { detailsBlock, detailsIsClosed, outsideDetailsBlock } from "./helpers/markup.ts";
import type { HomunClientError as HomunClientErrorType } from "../apps/web/src/lib/homun-errors.ts";

const RAW_MESSAGE = "Local model interpret failed: [Errno 61] Connection refused";

test("errore senza testo di prodotto: principale «Errore imprevisto.», dettagli chiusi con codice e originale", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/HomunErrorNotice.tsx",
    "HomunErrorNotice",
  );
  try {
    const errors = (await ui.loadModule("/apps/web/src/lib/homun-errors.ts")) as {
      HomunClientError: new (
        code: HomunClientErrorType["code"],
        message: string,
      ) => HomunClientErrorType;
    };
    const markup = ui.render({ error: new errors.HomunClientError("unknown", RAW_MESSAGE) });

    assert.match(outsideDetailsBlock(markup), /Errore imprevisto\./);
    const details = detailsBlock(markup);
    assert.ok(details, "il blocco Dettagli tecnici deve esserci");
    assert.ok(detailsIsClosed(details), "chiuso di default");
    assert.match(details, /<summary>Dettagli tecnici<\/summary>/);
    assert.match(details, /data-homun-error-detail="code">unknown</);
    assert.match(details, /\[Errno 61\] Connection refused/);
    assert.match(details, /Copia<\/button>/);
    assert.doesNotMatch(outsideDetailsBlock(markup), /Errno/);
    assert.doesNotMatch(outsideDetailsBlock(markup), /Local model interpret/);
  } finally {
    await ui.close();
  }
});

test("errore con testo di prodotto: stesso schema, l'originale resta nei dettagli", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/HomunErrorNotice.tsx",
    "HomunErrorNotice",
  );
  try {
    const errors = (await ui.loadModule("/apps/web/src/lib/homun-errors.ts")) as {
      HomunClientError: new (
        code: HomunClientErrorType["code"],
        message: string,
      ) => HomunClientErrorType;
    };
    const markup = ui.render({
      error: new errors.HomunClientError("provider_unavailable", RAW_MESSAGE),
    });

    assert.match(outsideDetailsBlock(markup), /Il modello non è disponibile\./);
    const details = detailsBlock(markup);
    assert.ok(details);
    assert.ok(detailsIsClosed(details));
    assert.match(details, /data-homun-error-detail="code">provider_unavailable</);
    assert.match(details, /\[Errno 61\]/);
    assert.doesNotMatch(outsideDetailsBlock(markup), /Errno/);
  } finally {
    await ui.close();
  }
});

test("validation_error: frase di prodotto principale; eccezione grezza → fallback con grezzo nei dettagli", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/HomunErrorNotice.tsx",
    "HomunErrorNotice",
  );
  try {
    const errors = (await ui.loadModule("/apps/web/src/lib/homun-errors.ts")) as {
      HomunClientError: new (
        code: HomunClientErrorType["code"],
        message: string,
      ) => HomunClientErrorType;
    };

    // frase di prodotto del motore: resta il testo principale…
    const phraseMarkup = ui.render({
      error: new errors.HomunClientError(
        "validation_error",
        "Il campo scadenza non può essere nel passato.",
      ),
    });
    assert.match(outsideDetailsBlock(phraseMarkup), /scadenza non può essere nel passato/);
    // …e il blocco mostra solo il codice: il messaggio coincide col principale
    assert.match(phraseMarkup, /data-homun-error-detail="code">validation_error</);
    assert.doesNotMatch(phraseMarkup, /data-homun-error-detail="message"/);

    // eccezione grezza: fallback di prodotto, grezzo confinato nel blocco
    const rawMarkup = ui.render({
      error: new errors.HomunClientError(
        "validation_error",
        "ValueError: invalid literal for int() with base 10: 'x'",
      ),
    });
    assert.match(outsideDetailsBlock(rawMarkup), /La richiesta non è valida\./);
    const details = detailsBlock(rawMarkup);
    assert.ok(details);
    assert.match(details, /ValueError/);
    assert.doesNotMatch(outsideDetailsBlock(rawMarkup), /ValueError/);
  } finally {
    await ui.close();
  }
});
