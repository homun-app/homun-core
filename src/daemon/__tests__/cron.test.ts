// Test del calcolo del prossimo run (cron a 5 campi + secondi opzionali),
// fuso orario locale come node-cron. Date costruite in locale per essere
// deterministici su qualunque macchina.
import { describe, expect, it } from 'vitest'
import { parseCron, nextCronRun } from '../cron'

// 26 marzo 2026 è un giovedì
const thursday = new Date(2026, 2, 26, 10, 30, 15).getTime()

describe('parseCron', () => {
  it('cron validi a 5 e 6 campi', () => {
    expect(parseCron('* * * * *')).not.toBeNull()
    expect(parseCron('0 9 * * *')).not.toBeNull()
    expect(parseCron('*/5 * * * *')).not.toBeNull()
    expect(parseCron('1-5 * * * *')).not.toBeNull()
    expect(parseCron('0 0 1 1 *')).not.toBeNull()
    expect(parseCron('30 8 * * mon-fri')).not.toBeNull()
    expect(parseCron('0 0 * jan,dec *')).not.toBeNull()
    expect(parseCron('15 * * * 7')).not.toBeNull() // 7 = domenica
    expect(parseCron('0 0 0 1 1 *')).not.toBeNull() // 6 campi (secondi)
  })

  it('cron invalidi → null', () => {
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('* * * * * * *')).toBeNull()
    expect(parseCron('60 * * * *')).toBeNull()
    expect(parseCron('* 24 * * *')).toBeNull()
    expect(parseCron('* * 0 * *')).toBeNull()
    expect(parseCron('* * 32 * *')).toBeNull()
    expect(parseCron('* * * 13 *')).toBeNull()
    expect(parseCron('* * * * 8')).toBeNull()
    expect(parseCron('a * * * *')).toBeNull()
    expect(parseCron('*/0 * * * *')).toBeNull()
    expect(parseCron('5-1 * * * *')).toBeNull()
  })

  it('7 viene normalizzato a 0 (domenica)', () => {
    const f = parseCron('0 0 * * 7')!
    expect(f.daysOfWeek.has(0)).toBe(true)
    expect(f.daysOfWeek.has(7)).toBe(false)
  })
})

describe('nextCronRun', () => {
  it('ogni minuto: il prossimo scatto è il minuto dopo', () => {
    const next = nextCronRun('* * * * *', thursday)!
    expect(new Date(next)).toEqual(new Date(2026, 2, 26, 10, 31, 0))
  })

  it('"0 9 * * *": domani alle 9 se oggi sono già passate le 9', () => {
    const next = nextCronRun('0 9 * * *', thursday)!
    expect(new Date(next)).toEqual(new Date(2026, 2, 27, 9, 0, 0))
  })

  it('"0 9 * * *": oggi alle 9 se il from è prima', () => {
    const early = new Date(2026, 2, 26, 7, 0).getTime()
    const next = nextCronRun('0 9 * * *', early)!
    expect(new Date(next)).toEqual(new Date(2026, 2, 26, 9, 0, 0))
  })

  it('"*/5 * * * *": sale di 5 in 5 minuti', () => {
    const next = nextCronRun('*/5 * * * *', thursday)!
    expect(new Date(next)).toEqual(new Date(2026, 2, 26, 10, 35, 0))
  })

  it('fascia oraria "0 9-17 * * *" con lista di minuti', () => {
    // 10:30 → prossimo match 10:45
    const a = nextCronRun('0,45 9-17 * * *', thursday)!
    expect(new Date(a)).toEqual(new Date(2026, 2, 26, 10, 45, 0))
    // 17:30 → ancora nella fascia: 17:45 stesso giorno
    const inWindow = new Date(2026, 2, 26, 17, 30).getTime()
    const b = nextCronRun('0,45 9-17 * * *', inWindow)!
    expect(new Date(b)).toEqual(new Date(2026, 2, 26, 17, 45, 0))
    // 17:46 → fascia chiusa: domani alle 9
    const after = new Date(2026, 2, 26, 17, 46).getTime()
    const c = nextCronRun('0,45 9-17 * * *', after)!
    expect(new Date(c)).toEqual(new Date(2026, 2, 27, 9, 0, 0))
  })

  it('giorni feriali "0 8 * * mon-fri": venerdì → lunedì', () => {
    const friday = new Date(2026, 2, 27, 9, 0).getTime()
    const next = nextCronRun('0 8 * * mon-fri', friday)!
    expect(new Date(next)).toEqual(new Date(2026, 2, 30, 8, 0, 0)) // 30 marzo = lunedì
  })

  it('weekend "0 10 * * sat,sun": giovedì → sabato', () => {
    const next = nextCronRun('0 10 * * sat,sun', thursday)!
    expect(new Date(next)).toEqual(new Date(2026, 2, 28, 10, 0, 0)) // sabato
  })

  it('wrap dell\'anno: "0 0 1 1 *" da dicembre → gennaio successivo', () => {
    const dec = new Date(2026, 11, 15, 0, 0).getTime()
    const next = nextCronRun('0 0 1 1 *', dec)!
    expect(new Date(next)).toEqual(new Date(2027, 0, 1, 0, 0, 0))
  })

  it('semantica OR dom/dow: "0 0 13 * 5" = 13 del mese OPPURE venerdì', () => {
    // giovedì 26 marzo: prossimo venerdì è il 27
    const next = nextCronRun('0 0 13 * 5', thursday)!
    expect(new Date(next)).toEqual(new Date(2026, 2, 27, 0, 0, 0))
    // da venerdì 27: il prossimo è il 13 aprile (che è anche lunedì) —
    // il 13 del mese vince perché aprile ha un 13 prima di un venerdì? no:
    // 3 aprile è venerdì →vince il venerdì
    const fri = new Date(2026, 2, 27, 1, 0).getTime()
    const next2 = nextCronRun('0 0 13 * 5', fri)!
    expect(new Date(next2)).toEqual(new Date(2026, 3, 3, 0, 0, 0)) // venerdì 3 aprile
  })

  it('29 febbraio: dal 1 mar 2026 (non bisestile) salta al 29 feb 2028', () => {
    const mar = new Date(2026, 2, 1, 0, 0).getTime()
    const next = nextCronRun('0 0 29 2 *', mar)!
    expect(new Date(next)).toEqual(new Date(2028, 1, 29, 0, 0, 0))
  })

  it('6 campi con secondi: "30 0 9 * * *" scatta alle 9:00:30', () => {
    const next = nextCronRun('30 0 9 * * *', thursday)!
    expect(new Date(next)).toEqual(new Date(2026, 2, 27, 9, 0, 30))
  })

  it('espressione mai verificabile → null (30 febbraio)', () => {
    expect(nextCronRun('0 0 30 2 *', thursday)).toBeNull()
  })

  it('schedule invalida → null (mai un match)', () => {
    expect(nextCronRun('nope', thursday)).toBeNull()
  })

  it('identico se from è esattamente un match: il next è strettamente DOPO', () => {
    const at = new Date(2026, 2, 26, 9, 0, 0).getTime()
    const next = nextCronRun('0 9 * * *', at)!
    expect(new Date(next)).toEqual(new Date(2026, 2, 27, 9, 0, 0))
  })
})
