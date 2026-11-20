// B2 (fase beta10-correzioni): decodifica PNG pura per i test dell'icona —
// niente dipendenze npm nuove: zlib di Node + l'unfiltering dei filtri PNG.
// Copre quello che serve ai test: 8 bit, RGBA (color type 6), non interlacciato.
import { inflateSync } from 'node:zlib'

export type Rgba = { r: number; g: number; b: number; a: number }

export type DecodedPng = {
  width: number
  height: number
  /** pixel RGBA, riga per riga (length = width * height) */
  pixels: Rgba[]
}

const CHUNK = (view: DataView, pos: number) => {
  const len = view.getUint32(pos)
  const type = String.fromCharCode(view.getUint8(pos + 4), view.getUint8(pos + 5), view.getUint8(pos + 6), view.getUint8(pos + 7))
  return { len, type, data: pos + 8 }
}

export function decodePng(buf: Uint8Array): DecodedPng {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (view.getUint8(i) !== sig[i]) throw new Error('non è un PNG (firma errata)')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = -1
  const idat: Uint8Array[] = []
  while (pos + 12 <= buf.byteLength) {
    const { len, type, data } = CHUNK(view, pos)
    if (type === 'IHDR') {
      width = view.getUint32(data)
      height = view.getUint32(data + 4)
      bitDepth = view.getUint8(data + 8)
      colorType = view.getUint8(data + 9)
      interlace = view.getUint8(data + 12)
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(data, data + len))
    } else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`PNG non supportato dai test: bit ${bitDepth}, colore ${colorType} (serve 8/RGBA)`)
  if (interlace !== 0) throw new Error('PNG interlacciato: non previsto')
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = new Uint8Array(stride * height)
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const byte = raw[src++]
      const left = x >= bpp ? out[row + x - bpp] : 0
      const up = y > 0 ? out[row - stride + x] : 0
      const upLeft = y > 0 && x >= bpp ? out[row - stride + x - bpp] : 0
      switch (filter) {
        case 0: out[row + x] = byte; break
        case 1: out[row + x] = (byte + left) & 0xff; break
        case 2: out[row + x] = (byte + up) & 0xff; break
        case 3: out[row + x] = (byte + ((left + up) >> 1)) & 0xff; break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft)
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          out[row + x] = (byte + pred) & 0xff; break
        }
        default: throw new Error(`filtro PNG sconosciuto: ${filter}`)
      }
    }
  }
  const pixels: Rgba[] = []
  for (let i = 0; i < width * height; i++) {
    pixels.push({ r: out[i * 4], g: out[i * 4 + 1], b: out[i * 4 + 2], a: out[i * 4 + 3] })
  }
  return { width, height, pixels }
}

export const px = (png: DecodedPng, x: number, y: number): Rgba => {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) throw new Error(`pixel fuori (${x},${y}) in ${png.width}x${png.height}`)
  return png.pixels[y * png.width + x]
}

export const hex = (p: Rgba): string =>
  [p.r, p.g, p.b].map((v) => v.toString(16).padStart(2, '0')).join('') + `@${p.a}`
