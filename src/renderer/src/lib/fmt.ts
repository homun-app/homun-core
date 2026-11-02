// Fase 16c correzioni (R5.3): la valuta segue la lingua dell'interfaccia —
// Intl.NumberFormat(locale, USD) al posto della virgola fissa: «$0,012» in
// italiano, «$0.012» in inglese. Le CIFRE DECIMALI restano quelle di oggi:
// due per importi ≥ 1, tre sotto (i costi per token sono piccoli). Il
// simbolo resta in TESTA come oggi: i pezzi del numero (separatore, cifre
// decimali, segno) vengono da Intl nella lingua attiva.
export function fmtUsd(n: number, locale: string): string {
  const digits = Math.abs(n) >= 1 ? 2 : 3
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).formatToParts(n)
  const symbol = parts.find((p) => p.type === 'currency')?.value ?? '$'
  const minus = n < 0 ? '-' : ''
  const number = parts
    .filter((p) => p.type !== 'currency' && p.type !== 'minusSign')
    .map((p) => p.value)
    .join('')
    // in it Intl mette uno spazio fra numero e simbolo: con il simbolo in
    // testa lo spazio di coda si toglie
    .trim()
  return `${minus}${symbol}${number}`
}
