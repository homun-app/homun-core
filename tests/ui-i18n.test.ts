import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getLanguage,
  setLanguage,
  subscribeLanguage,
  getDictionary,
  formatString,
} from "../apps/web/src/lib/i18n/index.ts";
import { it } from "../apps/web/src/lib/i18n/locales/it.ts";
import { en } from "../apps/web/src/lib/i18n/locales/en.ts";

test("i18n defaults to Italian and allows switching", () => {
  assert.equal(getLanguage(), "it");
  let notified = "";
  const unsub = subscribeLanguage((lang) => {
    notified = lang;
  });

  setLanguage("en");
  assert.equal(getLanguage(), "en");
  assert.equal(notified, "en");

  unsub();
  setLanguage("it");
  assert.equal(getLanguage(), "it");
});

test("formatString replaces {key} parameters accurately", () => {
  const result = formatString("Approva e passa a «{next}»", { next: "Analisi Prezzi" });
  assert.equal(result, "Approva e passa a «Analisi Prezzi»");

  const unformatted = formatString("Messaggio fisso senza placeholder");
  assert.equal(unformatted, "Messaggio fisso senza placeholder");
});

test("dictionary parity between Italian and English", () => {
  const itDict = it;
  const enDict = en;

  // Check all top-level sections
  for (const section of Object.keys(itDict) as (keyof typeof itDict)[]) {
    assert.ok(section in enDict, `Section ${section} missing from English dictionary`);
    const itSection = itDict[section];
    const enSection = enDict[section];

    for (const key of Object.keys(itSection) as (keyof typeof itSection)[]) {
      assert.ok(key in enSection, `Key ${section}.${String(key)} missing from English dictionary`);
      assert.ok(typeof enSection[key] === "string", `Key ${section}.${String(key)} is not a string`);
      assert.ok((enSection[key] as string).length > 0, `Key ${section}.${String(key)} is empty`);
    }
  }
});
