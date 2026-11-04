# Loghi dei provider

I loghi SVG dei provider di modelli, uno per **kind**: `ollama.svg`,
`lmstudio.svg`, `anthropic.svg`, `openai.svg`, `mistral.svg`, `zai.svg`,
`openrouter.svg`, `xai.svg`, `deepseek.svg`, `groq.svg`.

Si scaricano con `node scripts/aggiorna-loghi-provider.mjs` (li prende da
`logos.composio.dev/api/<slug>`, li ripulisce con la stessa `sanitizeSvg` dei
loghi delle app). Lo script lo lanciamo noi a mano: **l'app non scarica mai
niente da sola**, e finché un file manca la riga del provider usa l'iniziale.

Nel tema scuro il marchio sta su una piastrella chiara (`dark:bg-white`), come
i loghi delle app nella finestra «App e skill».
