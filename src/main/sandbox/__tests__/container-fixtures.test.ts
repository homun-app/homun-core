// Fase box-apple-cli-vera (BAV1): le uscite VERE della CLI `container` 1.7.1
// vivono nelle fixture, copiate alla lettera (l'unica sostituzione è la
// RADICE dei percorsi: /Users/test/ → /Users/test/, l'appRoot neutro di
// OBV1). Questo test le blocca BYTE PER BYTE (sha256 fissi) e blocca anche
// lo SCRIPT di copia: rieseguirlo deve dare gli STESSI byte del repo.
// BRV1 (fase box-apple-rete-vera): entrano le 10 help che BAV segnalava
// mancanti — il contratto argv↔help le pretende TUTTE.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const FIXTURES = join(ROOT, 'src', 'main', 'sandbox', '__tests__', 'fixtures', 'container-1.7.1')
const SCRIPT = join(ROOT, 'scripts', 'copia-fixture-container-1.7.1.mjs')
const SRC = '/Users/test/SandBot/prompts/fixtures/container-1.7.1'

/** Gli sha256 delle fixture copiate (byte per byte, radice /Users/test). */
const SHA256: Record<string, string> = {
  'build-help.txt': 'e8f8e0e40d6e95aa45b8c74b17d63bfc4436bc31e1b29dd8676fcf85c672bbcd',
  // U4 (fase prima-release): i dati VERI della spec (df con reclaimable
  // 6.946.705.408 e ls col buildkit FERMO) e la help di builder delete
  // trascritta dalla citazione della spec
  'builder-delete-help.txt': 'c459b41af4a3ad58afbde19eb5ba3abc81a83fc918431af625a374301ebef4d0',
  'ls-a-prima-release.txt': 'cb7fb08036bd1506e73d8eaded8b4dfa76a4e6a380195020252a83c48d95db26',
  'system-df-prima-release.txt': '4f427769a7bafde0c0dd3c4e0882fbe844b2b8aa5c14e02e6b7d13de27751e24',
  'cp-help.txt': 'e3e876fe12975530a926cf21aacbbc2525fdbf11af343673901babf7739fdf35',
  'exec-env.txt': '36425bfca5a8522b84b478ec363749b283d648c2adc01b397ba5aca9547beea2',
  'exec-help.txt': 'f0c579a0a79ae45465a00af0d86f9f263a3761791e5c841e9b6f8d11c20b7600',
  'exec-stdin-i.txt': '5817aa3e4e33f0440d3c836b2187d5314ef01eace225d15bfd4dd02d5a8aad20',
  'exec-test-w.txt': 'd439f786047ab7ca558442fb59dd2cc736c64bf851b638bf7755ec449445bd3a',
  'exec-u0-id.txt': '20c67f4b607e12e46a7a6847170e829d4132f6e5f7352d98ec153de182b0fb5a',
  'exec-user-w.txt': '117318525176b00ef4967aa3fa5cbab8cf984ab21b8419ed2d3717538e6992f5',
  'image-delete-help.txt': 'f5cd2baa2f924aae5438e89b152c059e78e45ec33643523bdfc01924c8607be0',
  'image-inspect-help.txt': '95dae33030757b539142d832e6fe93762065a66cfe741e3e7b91f6e9b1a57270',
  'image-inspect.txt': '3df9f724d231d8cd64367a9c238b68e90cc22a894ad297d5294769a60941c6e7',
  'image-ls-json.txt': '75989c3863cfa17c5812ba2937d33d5e1136a94c65cbc5d9dbbd1d7fa0d58e98',
  'image-prune-help.txt': 'c58c1538d8901b9e9196ab0fb516da5c802670f12a982d97e1384e86cb689c07',
  'inspect-box.txt': '023312998415ddd2138ad14f0bfeef679c9d2c6d4aeb22870959fe7e78c9a09d',
  'inspect-help.txt': 'b3b32f492ae109fcbe22d60f39b8a6159ead7a3ccdfe0083937a389c89180374',
  'inspect-missing.txt': '2b60688795610c2d35e9a1cfa8f7c372abb93ed4b73b18de640b57a52e9f5c69',
  'ls-a-json.txt': 'f5949262362035b086220e828af6190b8e6ba2402918a7288fcba090322a9633',
  'ls-a-quiet.txt': '88865686e86c01aebb020ef6752d801fac7dd3753fc622f1ebfe641742a324cf',
  'ls-a-table.txt': '902ff0a2dc0d0f80862358c3ddb827a8dab8a77806c3e13e50773cad01bf0e7a',
  'ls-help.txt': '2a959a3e843992dff30e0295877b4a69c0742852eb69b76620afeafd39600812',
  'network-create-help.txt': 'bf970aecd52141ca87d6182575eb48f8d8e30d9306f9d28bd62374a0fd36a315',
  'network-inspect-default.txt': 'ce82ed8395f5b1beba8f84a1288813c60d5c248d008fcb04a37e2fdfcdc2a63f',
  'network-inspect-help.txt': 'cc21a5a52855eb04172250033d710b28c29ec1acb01266e87d475e7096e9e9e7',
  'network-inspect-homun-box.txt': '171ee83f8f53a9bcea45ff2c68ad242483df0a41775bff63d681a0922c965671',
  'network-ls-json.txt': '371cf463ffbb6165c63353dc1c92a2c2776a13ef8954616d9b7594749589bab1',
  'rm-help.txt': '020063e9e8b84528c76e79d6ca58f6d39e971e0c273e9b4cf3e7b3a280a7c817',
  'run-help.txt': 'b56f78929a58b9ba795d9dfdf1d7fcfcec07ff8e3074ee28da40bd2fdb8e856d',
  'start-help.txt': 'f6522ded8d56e2209bcdf6eb3021d86455f1f9d7c6f3e4bd2dc3e10670bebe82',
  'stop-help.txt': '4e34ca5feedb0088f4629b669e5330e443e8d40cdb07dd72f13a2f9ac8aefda1',
  'system-df-help.txt': '01166ead7c4f85b8ba995baa7e9f41b12298069e571b2b13f9cfc2310b0d3e54',
  'system-df-json.txt': 'b49396164c70f7a7b22f71fb5a662f1ce3c407cf92baee91af0fee05ec29a7d7',
  'system-kernel-set-help.txt': '85d80f4f1f0833c7e88bcac3f8c4c71573269b0dae78f08d11fbd63b5997fb02',
  'system-start-help.txt': 'bb2255b1bfc580bb43cbda276fcc75672d1bac82787d7f490c751d93dd4a5bbe',
  'system-status-help.txt': '108ee9d3fb3aa580033c88266ee76cce9caf06fc313c0cae4ac8357418e01ab3',
  'volume-create-exists.txt': 'd2810d2fb87156cee65b4f204c76362ab2fa075f90f86a8e917940bd06e53ef0',
  'volume-create-help.txt': '82723ba58f02824f6fb9e663aa7b14b9c698c2d70efb5709d9d46c8e8cc6c10d',
  'volume-delete-help.txt': '65d1c49894288251670ab414cfac9e116d1ee2a35d792752bc7b0578205ec0f1',
  'volume-inspect-plugins.txt': '7eb3d57ec13563d7a7d1e5358e8c8f048ad77f99422f59a415a0d956c1ad22eb',
  'volume-ls-help.txt': '2bdb60e60c3950f3fac13ddc56e72f0a422ebdc8c9847171ebe6817a7c94f0c0',
  'volume-ls-json.txt': 'a3ad49d2e5b2d71064a2b1b15af6d174c9651b7f6854ab83263e3ab38df93b84'
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

describe('BAV1: le fixture della CLI vera 1.7.1, byte per byte', () => {
  it('ogni file del repo è quello copiato (sha256 fisso) e la cartella ha ESATTAMENTE quei file', () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.txt')).sort()
    expect(files).toEqual(Object.keys(SHA256).sort())
    for (const f of files) expect(sha(readFileSync(join(FIXTURES, f), 'utf8')), f).toBe(SHA256[f])
  })

  it('la forma delle fixture: la prima riga è il comando `$ container …` (quando c\'è: network-inspect-homun-box parte dal JSON), l\'ultima è `[exit N]`', () => {
    for (const f of Object.keys(SHA256)) {
      const text = readFileSync(join(FIXTURES, f), 'utf8')
      // network-inspect-homun-box.txt è l'unica senza la riga di comando: la
      // fixture vera comincia col JSON (copiata tale e quale)
      if (!text.startsWith('[')) expect(text.startsWith('$ container '), f).toBe(true)
      expect(/\[exit \d+\]\n?$/.test(text), f).toBe(true)
    }
  })

  it('la radice NEUTRA: nessun /Users/test nelle fixture del repo (solo /Users/test/)', () => {
    for (const f of Object.keys(SHA256)) {
      const text = readFileSync(join(FIXTURES, f), 'utf8')
      expect(text, f).not.toContain('/Users/test')
    }
    expect(readFileSync(join(FIXTURES, 'inspect-box.txt'), 'utf8')).toContain('/Users/test/Library/Application Support/com.apple.container/volumes/sandbot-box/volume.img')
  })

  // lo script che copia: rieseguirlo (sulla cartella delle prove dal vivo)
  // deve dare gli STESSI byte del repo — la sostituzione tocca SOLO la radice
  it.skipIf(!existsSync(SRC))('lo script di copia riproduce il repo byte per byte (solo la radice cambia)', () => {
    const dst = join(TEST_TMP_BASE, `sandbot-fixture-copy-${process.pid}`)
    rmSync(dst, { recursive: true, force: true })
    const r = spawnSync(process.execPath, [SCRIPT, SRC, dst], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    const copied = readdirSync(dst).filter((f) => f.endsWith('.txt')).sort()
    expect(copied).toEqual(Object.keys(SHA256).sort())
    for (const f of copied) {
      expect(readFileSync(join(dst, f), 'utf8'), f).toBe(readFileSync(join(FIXTURES, f), 'utf8'))
    }
    rmSync(dst, { recursive: true, force: true })
  })

  // il test della sostituzione È il contratto dello script: la radice cambia
  // SOLO lei, il resto è l'uscita vera tale e quale
  it.skipIf(!existsSync(SRC))('nella sorgente c\'è la home vera, nel repo la neutra: la differenza è SOLO la radice', () => {
    for (const f of readdirSync(SRC).filter((x) => x.endsWith('.txt')).sort()) {
      const src = readFileSync(join(SRC, f), 'utf8')
      const dst = readFileSync(join(FIXTURES, f), 'utf8')
      expect(dst, f).toBe(src.split('/Users/test/').join('/Users/test/'))
    }
  })
})