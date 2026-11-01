// La codifica dei frame del TERMINALE del bot (fase 19b, T2.4) — modulo PURO
// condiviso dal renderer (che incapsula l'input) e dai test. Il canale è uno
// solo: l'uscita del computer sono byte grezzi, l'ingresso viaggia come frame
// `[kind:u8][length:u32be][payload]` così tasti e resize condividono lo
// stesso flusso — 0 = byte per il pty, 1 = resize (cols:u16be rows:u16be).
// Adattato da Rakazo (Apache-2.0), src/contracts/terminal.ts.

/** Un frame di INPUT: byte da scrivere nel pty. */
export const TERMINAL_INPUT = 0

/** Un frame di RESIZE: payload di 4 byte cols:u16be rows:u16be. */
export const TERMINAL_RESIZE = 1

/** Il tetto di un frame: oltre, il programma nel box chiude la sessione. */
export const TERMINAL_MAX_FRAME = 1 << 20

/** Codifica un frame completo (PURO). */
export function encodeTerminalFrame(kind: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(5 + payload.length)
  const view = new DataView(frame.buffer)
  view.setUint8(0, kind)
  view.setUint32(1, payload.length)
  frame.set(payload, 5)
  return frame
}

/** Il frame di input per un testo (UTF-8, PURO). */
export function encodeTerminalInput(text: string): Uint8Array<ArrayBuffer> {
  return encodeTerminalFrame(TERMINAL_INPUT, new TextEncoder().encode(text))
}

/** Il frame di resize, con cols e rows limitati a 1–1000 (PURO). */
export function encodeTerminalResize(cols: number, rows: number): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(4)
  const view = new DataView(payload.buffer)
  view.setUint16(0, clampTerminalSize(cols))
  view.setUint16(2, clampTerminalSize(rows))
  return encodeTerminalFrame(TERMINAL_RESIZE, payload)
}

/** La misura del terminale, limitata a 1–1000 (PURO; NaN e 0 → 1). */
export function clampTerminalSize(value: number): number {
  return Math.min(1000, Math.max(1, Math.round(value) || 1))
}
