// G4 (fase guida): dove si trova la chiave di ogni provider — la pagina
// delle chiavi del fornitore, aperta nel browser dall'helper dei link
// esterni (il main apre SOLO http/https, vedi external-url.ts). Costante
// PURA: kind → URL. Nessun nome inventato: solo i tipi con chiave che
// esistono nel foglio di collegamento.
export const PROVIDER_KEY_URLS: Readonly<Partial<Record<string, string>>> = Object.freeze({
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/keys',
  xai: 'https://console.x.ai/',
  mistral: 'https://console.mistral.ai/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  groq: 'https://console.groq.com/keys',
  zai: 'https://z.ai/manage/apikey'
})

/** L'URL della pagina delle chiavi del kind, o null se non ce l'ha. */
export function providerKeyUrl(kind: string): string | null {
  return PROVIDER_KEY_URLS[kind] ?? null
}
