// Fase box-container (BX2): le protezioni del box con Apple container. Pure:
// - UTENTE non root (-u 1000:1000, come CONTAINER_USER di Docker);
// - --init C'È (BAV4: la help vera della CLI 1.7.1 lo dichiara), NESSUN
//   --cap-drop/--security-opt nel nostro argv e NESSUN --pids-limit (non
//   esiste: il confine è la VM per container; pids si annota nel REPORT);
// - limiti --memory/--cpus da DEFAULT_BOX_LIMITS;
// - la RETE dedicata --internal homun-box (il box parla SOLO col Mac) e il
//   browser che raggiunge il proxy al GATEWAY di quella rete, al posto di
//   host.docker.internal (sostituzione che tocca SOLO --proxy-server);
// - i TRE volumi di oggi: box rw, plugin :ro dal kernel, browser rw;
// - l'immagine del box senza bit setuid utili (la riga di pulizia nel
//   Dockerfile: con --cap-drop assente, un setuid in più peserebbe).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APPLE_BOX_NETWORK,
  APPLE_BOX_ISOLATED_NETWORK,
  appleNetworkOf,
  appleBoxRunArgv,
  appleNetworkCreateArgv,
  appleNetworkInspectArgv,
  appleIsolateLinkDownArgv,
  appleIsolationCheckArgv,
  appleBoxInspectArgv,
  appleBrowserMcpArgv,
  browserMcpFlagsWithGateway,
  parseNetworkGateway,
  parseNetworkSubnet,
  appleSystemStartArgv,
  appleKernelSetRecommendedArgv
} from '../apple-container-argv'
import { DEFAULT_BOX_LIMITS, browserMcpFlags, CONTAINER_USER, BOX_MOUNT, PLUGINS_MOUNT, BROWSER_MOUNT } from '../docker-argv'
const { ensureAppleBoxNetwork, boxNetworkGateway, setBoxNetworkGateway, boxNetworkSubnet, setBoxNetworkSubnet, appleContainerEngine } = await import('../apple-container-engine')

const FIXTURES = join(import.meta.dirname, 'fixtures', 'container-1.7.1')

/** Il corpo di una fixture: senza la riga `$ container…` e senza `[exit N]`. */
const fixture = (name: string): string => {
  const text = readFileSync(join(FIXTURES, name), 'utf8')
  return text.replace(/^\$ container[^\n]*\n/, '').replace(/\[exit \d+\]\n?$/, '').trim()
}

const runArgv = (network: 'bridge' | 'none') =>
  appleBoxRunArgv('sandbot-box', 'sandbot-box', network, DEFAULT_BOX_LIMITS, 'sandbot-box:abc')

describe('BX2: le protezioni del box con container', () => {
  it('utente non root: -u 1000:1000 come CONTAINER_USER', () => {
    const argv = runArgv('bridge')
    const i = argv.indexOf('-u')
    expect(argv[i + 1]).toBe(CONTAINER_USER)
    expect(argv[i + 1]).toBe('1000:1000')
  })

  it('limiti: --memory e --cpus da DEFAULT_BOX_LIMITS; pids NON esiste', () => {
    const argv = runArgv('bridge')
    expect(argv[argv.indexOf('-m') + 1]).toBe(DEFAULT_BOX_LIMITS.memory)
    expect(argv[argv.indexOf('-c') + 1]).toBe(String(DEFAULT_BOX_LIMITS.cpus))
    expect(argv.join(' ')).not.toContain('pids')
  })

  it('BAV4: --init C\'È (la help vera della 1.7.1 lo dichiara: PID 1 raccoglie gli zombie); NESSUN --cap-drop né --security-opt nel nostro argv', () => {
    const argv = runArgv('bridge')
    expect(argv).toContain('--init')
    expect(argv.join(' ')).not.toContain('--cap-drop')
    expect(argv.join(' ')).not.toContain('--security-opt')
  })

  it('i TRE volumi di oggi: box rw, plugin :ro dal KERNEL, browser rw', () => {
    const argv = runArgv('bridge')
    expect(argv).toContain('-v')
    const mounts = argv.filter((_, i) => argv[i - 1] === '-v')
    expect(mounts).toContain(`sandbot-box:${BOX_MOUNT}`)
    expect(mounts).toContain(`sandbot-plugins:${PLUGINS_MOUNT}:ro`)
    expect(mounts).toContain(`sandbot-browser:${BROWSER_MOUNT}`)
  })

  it('rete bridge: la rete DEDICATA --internal homun-box, creata con --internal', () => {
    const argv = runArgv('bridge')
    expect(argv[argv.indexOf('--network') + 1]).toBe(APPLE_BOX_NETWORK)
    expect(APPLE_BOX_NETWORK).toBe('homun-box')
    expect(appleNetworkCreateArgv()).toEqual(['network', 'create', '--internal', APPLE_BOX_NETWORK])
    expect(appleNetworkInspectArgv()).toEqual(['network', 'inspect', APPLE_BOX_NETWORK])
  })

  // BR1: il test di guardia SI ROVESCIA. Con la CLI di Apple non esiste una
  // rete «none»: un run SENZA --network va sulla rete PREDEFINITA di Apple,
  // in NAT verso Internet — l'esatto opposto di «senza rete». Ora il run
  // porta SEMPRE esattamente un --network col nome di una rete di Homun.
  it('BR1 rete none: --network homun-box-isolated E --no-dns (mai la rete predefinita)', () => {
    const argv = runArgv('none')
    expect(argv[argv.indexOf('--network') + 1]).toBe('homun-box-isolated')
    expect(argv).toContain('--no-dns')
  })

  it('BR1 SEMPRE esattamente UN --network, col nome di una rete di Homun; bridge senza --no-dns', () => {
    const HOMUN_NETWORKS = ['homun-box', 'homun-box-isolated']
    for (const network of ['bridge', 'none'] as const) {
      const argv = runArgv(network)
      expect(argv.filter((f) => f === '--network'), network).toHaveLength(1)
      expect(HOMUN_NETWORKS, network).toContain(argv[argv.indexOf('--network') + 1])
    }
    expect(runArgv('bridge')).not.toContain('--no-dns')
  })
})

// ---- BR1: la modalità none col motore Apple — isolata e VERIFICATA ----

describe('BR1: none → la rete isolata e le interfacce GIÙ (difesa in profondità)', () => {
  it('appleNetworkOf: la rete di Homun per modalità (bridge → homun-box, none → homun-box-isolated)', () => {
    expect(appleNetworkOf('bridge')).toBe('homun-box')
    expect(appleNetworkOf('none')).toBe('homun-box-isolated')
    expect(APPLE_BOX_ISOLATED_NETWORK).toBe('homun-box-isolated')
  })

  it('la rete isolata si crea --internal come homun-box, e si ispeziona per nome', () => {
    expect(appleNetworkCreateArgv('homun-box-isolated')).toEqual(['network', 'create', '--internal', 'homun-box-isolated'])
    expect(appleNetworkInspectArgv('homun-box-isolated')).toEqual(['network', 'inspect', 'homun-box-isolated'])
  })

  it('il link down: un exec COME ROOT (−u 0) che porta giù ogni interfaccia tranne lo', () => {
    const argv = appleIsolateLinkDownArgv('sandbot-box')
    expect(argv.slice(0, 4)).toEqual(['exec', '-u', '0', 'sandbot-box'])
    expect(argv).toContain('sh')
    const script = argv[argv.indexOf('-c') + 1]
    expect(script).toContain('ip link set')
    expect(script).toContain('lo')
  })

  it('la verifica: COME ROOT, ogni interfaccia diversa da lo deve essere operstate down', () => {
    const argv = appleIsolationCheckArgv('sandbot-box')
    expect(argv.slice(0, 4)).toEqual(['exec', '-u', '0', 'sandbot-box'])
    const script = argv[argv.indexOf('-c') + 1]
    expect(script).toContain('/sys/class/net/')
    expect(script).toContain('operstate')
    expect(script).toContain('lo')
  })

  it('BAV2: TUTTI i fatti del box esistente da UN solo inspect, senza --format (il JSON li dice)', () => {
    expect(appleBoxInspectArgv('sandbot-box')).toEqual(['inspect', 'sandbot-box'])
  })
})

describe('BX2: il proxy del browser al GATEWAY della rete interna', () => {
  // BRV3 (fase box-apple-rete-vera): il parse legge il JSON VERO della CLI
  // 1.7.1 — le FIXTURE delle prove dal vivo, `status.ipv4Gateway` del PRIMO
  // elemento dell'array. MAI regex sul testo, MAI ripieghi sul formato
  // inventato {subnets[]} della vecchia finta (erano loro che lasciavano il
  // gateway a null e il browser senza proxy). Visti FALLIRE il 2026-11-14:
  // le vecchie regex non scattavano sulla fixture vera.
  it('BRV3 parseNetworkGateway: status.ipv4Gateway del JSON VERO (fixture) → 192.168.128.1 / 192.168.64.1', () => {
    expect(parseNetworkGateway(fixture('network-inspect-homun-box.txt'))).toBe('192.168.128.1')
    expect(parseNetworkGateway(fixture('network-inspect-default.txt'))).toBe('192.168.64.1')
  })

  it('BRV3 parseNetworkGateway: JSON illeggibile, campo assente o formato INVENTATO → null (niente ripieghi sul testo)', () => {
    expect(parseNetworkGateway('')).toBeNull()
    expect(parseNetworkGateway('Error: network not found: homun-box')).toBeNull()
    expect(parseNetworkGateway('gateway: 192.0.9.1')).toBeNull() // riga di testo: VIA il ripiego
    expect(parseNetworkGateway('{}')).toBeNull()
    expect(parseNetworkGateway('[]')).toBeNull() // array VUOTO: nessun elemento da leggere
    expect(parseNetworkGateway(JSON.stringify([{ status: { ipv4Subnet: '192.168.128.0/24' } }]))).toBeNull() // c'è la subnet, non il gateway
    expect(parseNetworkGateway(JSON.stringify([{ status: { ipv4Gateway: 'non.un.ip' } }]))).toBeNull()
    expect(parseNetworkGateway('{"name":"homun-box","subnets":[{"gateway":"192.0.15.1"}]}')).toBeNull() // il vecchio formato della finta
  })

  it('BRV3 parseNetworkSubnet: status.ipv4Subnet dello stesso inspect (fixture) → 192.168.128.0/24', () => {
    expect(parseNetworkSubnet(fixture('network-inspect-homun-box.txt'))).toBe('192.168.128.0/24')
    expect(parseNetworkSubnet(fixture('network-inspect-default.txt'))).toBe('192.168.64.0/24')
    expect(parseNetworkSubnet('')).toBeNull()
    expect(parseNetworkSubnet('subnet: 192.0.9.0/24')).toBeNull() // VIA il ripiego sulle righe
    expect(parseNetworkSubnet(JSON.stringify([{ status: { ipv4Gateway: '192.168.128.1' } }]))).toBeNull()
    expect(parseNetworkSubnet(JSON.stringify([{ status: { ipv4Subnet: '192.168.128.0' } }]))).toBeNull() // non è un CIDR
    expect(parseNetworkSubnet('{"subnets":[{"subnet":"192.0.15.0/24"}]}')).toBeNull() // il vecchio formato
  })

  it('browserMcpFlagsWithGateway: --proxy-server cambia indirizzo, il RESTO dei flag resta identico e in ordine', () => {
    const base = browserMcpFlags('agent_x', 8085)
    const withGw = browserMcpFlagsWithGateway('agent_x', 8085, '192.0.15.1')
    const i = base.indexOf('--proxy-server')
    expect(base[i + 1]).toBe('http://host.docker.internal:8085')
    expect(withGw[i + 1]).toBe('http://192.0.15.1:8085')
    // SOLO il valore del proxy cambia: stessa lunghezza, stesso ordine
    expect(withGw.length).toBe(base.length)
    expect(withGw.filter((f, k) => f !== base[k])).toEqual(['http://192.0.15.1:8085'])
  })

  it('il launcher del browser col gateway: host.docker.internal SPARISCE dall\'argv', () => {
    const argv = appleBrowserMcpArgv('agent_x', 8085, { gateway: '192.0.15.1' }, 'sandbot-box')
    expect(argv.join(' ')).not.toContain('host.docker.internal')
    expect(argv.join(' ')).toContain('http://192.0.15.1:8085')
    // senza gateway (rete non ancora ispezionata) resta l'indirizzo di Docker:
    // l'avvio non tace, il gateway si legge all'ensure del box
    const fallback = appleBrowserMcpArgv('agent_x', 8085, {}, 'sandbot-box')
    expect(fallback.join(' ')).toContain('host.docker.internal')
  })
})

describe('BX2: l\'ensure della rete del box (ensureAppleBoxNetwork)', () => {
  /**
   * BRV3: l'uscita di un network inspect nella FORMA VERA della CLI 1.7.1
   * (il campo `status.ipv4Gateway`/`ipv4Subnet` del primo elemento — mai il
   * vecchio `subnets[]` inventato, che il parse di oggi non legge più).
   */
  const netJson = (gateway: string, subnet: string): string =>
    JSON.stringify([{ configuration: { creationDate: '2026-11-14T07:30:36Z', labels: {}, mode: 'hostOnly', name: 'homun-box', options: {}, plugin: 'container-network-vmnet' }, id: 'homun-box', status: { ipv4Gateway: gateway, ipv4Subnet: subnet, ipv6Subnet: 'fdcb:b3be:434:c533::/64' } }])

  /** Runner finto: la rete manca alla PRIMA inspect, c'è dopo la create. */
  const fakeRun = (calls: string[][]) => async (argv: string[]) => {
    calls.push(argv)
    if (argv[0] === 'network' && argv[1] === 'inspect') {
      return calls.filter((c) => c[1] === 'create').length > 0
        ? { stdout: netJson('192.0.15.1', '192.0.15.0/24'), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'network not found', exitCode: 1 }
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  }

  it('rete assente: inspect → create --internal → inspect → il GATEWAY si ricorda per il browser', async () => {
    setBoxNetworkGateway(null)
    const calls: string[][] = []
    const gw = await ensureAppleBoxNetwork(fakeRun(calls))
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['network inspect', 'network create', 'network inspect'])
    expect(calls[1]).toEqual(['network', 'create', '--internal', 'homun-box'])
    expect(gw).toBe('192.0.15.1')
    expect(boxNetworkGateway()).toBe('192.0.15.1')
    // e il launcher del browser del MOTORE lo usa (la cache vive nell'engine)
    expect(appleContainerEngine.argv.browserMcp('agent_x', 8085).join(' ')).toContain('http://192.0.15.1:8085')
    expect(appleContainerEngine.argv.browserMcp('agent_x', 8085).join(' ')).not.toContain('host.docker.internal')
    setBoxNetworkGateway(null)
  })

  it('rete già presente: SOLO l\'inspect, mai una create', async () => {
    const calls: string[][] = []
    const run = async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === 'network' && argv[1] === 'inspect') {
        return { stdout: netJson('192.0.2.1', '192.0.2.0/24'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const gw = await ensureAppleBoxNetwork(run)
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['network inspect'])
    expect(gw).toBe('192.0.2.1')
    setBoxNetworkGateway(null)
  })

  it('BR2: in bridge il gateway E la SOTTORETE si ricordano (il filtro del secondo ascolto)', async () => {
    setBoxNetworkGateway(null)
    setBoxNetworkSubnet(null)
    const run = async (argv: string[]) =>
      argv[0] === 'network' && argv[1] === 'inspect'
        ? { stdout: netJson('192.0.15.1', '192.0.15.0/24'), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 }
    await ensureAppleBoxNetwork(run)
    expect(boxNetworkGateway()).toBe('192.0.15.1')
    expect(boxNetworkSubnet()).toBe('192.0.15.0/24')
    setBoxNetworkGateway(null)
    setBoxNetworkSubnet(null)
  })

  it('BR1/BR2: in NONE la rete isolata si crea e ispeziona, MA il gateway della isolata NON diventa quello del proxy', async () => {
    setBoxNetworkGateway('192.0.15.1') // il gateway di homun-box, già noto
    setBoxNetworkSubnet(null)
    const calls: string[][] = []
    let created = false
    const run = async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === 'network' && argv[1] === 'inspect') {
        if (argv.includes('homun-box-isolated')) {
          return created
            ? { stdout: netJson('192.0.16.1', '192.0.16.0/24'), stderr: '', exitCode: 0 }
            : { stdout: '', stderr: 'network not found', exitCode: 1 }
        }
        return { stdout: netJson('192.0.15.1', '192.0.15.0/24'), stderr: '', exitCode: 0 }
      }
      if (argv[0] === 'network' && argv[1] === 'create') { created = true; return { stdout: '', stderr: '', exitCode: 0 } }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const gw = await ensureAppleBoxNetwork(run, 'none')
    expect(calls.some((c) => c[0] === 'network' && c[1] === 'create' && c.includes('homun-box-isolated'))).toBe(true)
    expect(gw).toBe('192.0.16.1') // quello della isolata, risposto dall'inspect di DOPO
    // ma la cache del proxy resta quella di homun-box: il proxy non ascolta MAI sulla isolata
    expect(boxNetworkGateway()).toBe('192.0.15.1')
    expect(boxNetworkSubnet()).toBeNull()
    setBoxNetworkGateway(null)
    setBoxNetworkSubnet(null)
  })
})

describe('BX2: il kernel e l\'accensione', () => {
  it('mai download nascosto: start con --disable-kernel-install; il kernel SOLO col consenso', () => {
    expect(appleSystemStartArgv()).toEqual(['system', 'start', '--disable-kernel-install'])
    expect(appleKernelSetRecommendedArgv()).toEqual(['system', 'kernel', 'set', '--recommended'])
  })
})

describe('BX2: l\'immagine del box senza setuid utili', () => {
  it('il Dockerfile TOGLIE i bit setuid/setgid dall\'immagine (con container niente --cap-drop)', () => {
    const dockerfile = readFileSync('resources/box/Dockerfile', 'utf8')
    expect(dockerfile).toContain('-perm -4000')
    expect(dockerfile).toContain('chmod a-s')
  })
})

// ---- OBV1 (fase onboarding-b-dal-vivo): lo status si legge davvero ----

import {
  parseSystemStatus,
  parseSystemStatusJson,
  parseSystemStatusTable,
  appleSystemStatusJsonArgv,
  appleSystemStatusArgv
} from '../apple-container-argv'
import { NEUTRAL_APP_ROOT, SYSTEM_STATUS_JSON, SYSTEM_STATUS_TABLE } from './system-status-fixtures'

describe('OBV1: il parse di `system status` sui formati VERI (puro, niente euristiche sul testo)', () => {
  it('il JSON vero → running, appRoot e arch letti dai campi (status === "running")', () => {
    expect(parseSystemStatusJson(SYSTEM_STATUS_JSON)).toEqual({ running: true, appRoot: NEUTRAL_APP_ROOT, arch: 'arm64' })
    expect(parseSystemStatus(SYSTEM_STATUS_JSON)).toEqual({ running: true, appRoot: NEUTRAL_APP_ROOT, arch: 'arm64' })
  })

  it('la TABELLA vera di default → running: true (prima era SEMPRE false: la tabella non ha «running:»)', () => {
    expect(parseSystemStatusTable(SYSTEM_STATUS_TABLE)).toEqual({ running: true, appRoot: NEUTRAL_APP_ROOT, arch: 'arm64' })
  })

  // OBD4d: \s+ attraversa il fine riga — con paths.appRoot VUOTO il valore
  // diventava quello della RIGA DOPO (paths.installRoot /usr/local/)
  it('OBD4d: paths.appRoot VUOTO → appRoot null, mai il valore della riga dopo', () => {
    const empty = SYSTEM_STATUS_TABLE.replace('paths.appRoot       ' + NEUTRAL_APP_ROOT, 'paths.appRoot       ')
    expect(empty).not.toContain(NEUTRAL_APP_ROOT) // la sostituzione è avvenuta
    const p = parseSystemStatusTable(empty)
    expect(p).toEqual({ running: true, appRoot: null, arch: 'arm64' })
    expect(p?.appRoot ?? '').not.toContain('installRoot')
    expect(p?.appRoot).not.toBe('/usr/local/')
  })

  it('parseSystemStatus prova il JSON e CADE sulla tabella quando il JSON non è valido', () => {
    expect(parseSystemStatus(SYSTEM_STATUS_TABLE)).toEqual({ running: true, appRoot: NEUTRAL_APP_ROOT, arch: 'arm64' })
    expect(parseSystemStatus('non è un JSON\n' + SYSTEM_STATUS_TABLE)).toEqual({ running: true, appRoot: NEUTRAL_APP_ROOT, arch: 'arm64' })
  })

  it('stopped: il JSON dice "stopped" → running false (il JSON valido basta, niente seconda chiamata)', () => {
    const stoppedJson = SYSTEM_STATUS_JSON.replace('"status":"running"', '"status":"stopped"')
    expect(parseSystemStatus(stoppedJson)).toEqual({ running: false, appRoot: NEUTRAL_APP_ROOT, arch: 'arm64' })
  })

  it('stopped: la tabella dice «status stopped» → running false', () => {
    const stoppedTable = SYSTEM_STATUS_TABLE.replace('status              running', 'status              stopped')
    expect(parseSystemStatus(stoppedTable)).toEqual({ running: false, appRoot: NEUTRAL_APP_ROOT, arch: 'arm64' })
  })

  it('uscita vuota, spazzatura o JSON senza status → tutto falso e niente appRoot (mai ottimisti)', () => {
    expect(parseSystemStatus('')).toEqual({ running: false, appRoot: null, arch: null })
    expect(parseSystemStatus('qualcosa è andato storto')).toEqual({ running: false, appRoot: null, arch: null })
    expect(parseSystemStatus('{"client":{"version":"1.7.1"}}')).toEqual({ running: false, appRoot: null, arch: null })
  })

  it('gli argv dello status: PRIMA il JSON, poi la tabella (il fallback è un\'altra chiamata)', () => {
    expect(appleSystemStatusJsonArgv()).toEqual(['system', 'status', '--format', 'json'])
    expect(appleSystemStatusArgv()).toEqual(['system', 'status'])
  })

  it('le vecchie euristiche sul testo sono VIA: il parse non ha più un campo kernelOk', () => {
    // la tabella vera non parla MAI del kernel: nessuna riga con «kernel …
    // missing» può più cambiarne l'esito — il kernel si rileva dal FILE
    const p = parseSystemStatus(SYSTEM_STATUS_TABLE + '\nkernel: missing (use: container system kernel set --recommended)')
    expect(p).toEqual({ running: true, appRoot: NEUTRAL_APP_ROOT, arch: 'arm64' })
  })
})
