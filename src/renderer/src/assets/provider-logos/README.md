# Loghi dei provider

I loghi SVG dei provider di modelli, uno per **kind**: `ollama.svg`,
`lmstudio.svg`, `anthropic.svg`, `openai.svg`, `mistral.svg`, `zai.svg`,
`openrouter.svg`, `xai.svg`, `deepseek.svg`, `groq.svg`.

Si scaricano con `node scripts/aggiorna-loghi-provider.mjs` (li prende da
`logos.composio.dev/api/<slug>`, li ripulisce con la stessa `sanitizeSvg` dei
loghi delle app). Lo script lo lanciamo noi a mano: **l'app non scarica mai
niente da sola**, e finché un file manca la riga del provider usa l'iniziale.

Nel tema scuro il marchio sta su una piastrella chiara (`dark:bg-white`), come
i loghi delle app nella pagina Plugin.

## U5 (fase prima-release): Anthropic e OpenAI sono curati a mano

`anthropic.svg` (la «A») e `openai.svg` (il fiore) vengono da **Simple Icons
15.0.0**, licenza **CC0**: sono i marchi veri, non i logo generici del CDN.
Entrambi monocromi con `fill="currentColor"` su fondo trasparente.

Regola dei monocromi: **nessuna piastrella** — il logo segue il colore del
testo nei due temi (per questo si rendono INLINE in `ProviderMark`: dentro un
`<img>` un SVG non eredita `currentColor`). Gli altri loghi restano come
sono, sulla piastrella del tema scuro.

Lo script `aggiorna-loghi-provider.mjs` **non li sovrascrive**: sono nella
lista di esclusione `LOGHI_ESCLUSI` (voci curate a mano, non dal CDN).
