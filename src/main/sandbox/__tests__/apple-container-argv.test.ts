// Fase box-container (BX2): le protezioni del box con Apple container. Pure:
// - UTENTE non root (-u 1000:1000, come CONTAINER_USER di Docker);
// - NESSUN --cap-drop/--security-opt/--init/--pids-limit (non esistono: il
//   confine è la VM per container; pids si annota nel REPORT);
// - limiti --memory/--cpus da DEFAULT_BOX_LIMITS;
// - la RETE dedicata --internal homun-box (il box parla SOLO col Mac) e il
//   browser che raggiunge il proxy al GATEWAY di quella rete, al posto di
//   host.docker.internal (sostituzione che tocca SOLO --proxy-server);
// - i TRE volumi di oggi: box rw, plugin :ro dal kernel, browser rw;
// - l'immagine del box senza bit setuid utili (la riga di pulizia nel
//   Dockerfile: con --cap-drop assente, un setuid in più peserebbe).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  APPLE_BOX_NETWORK,
  APPLE_BOX_ISOLATED_NETWORK,
  appleNetworkOf,
  appleBoxRunArgv,
  appleNetworkCreateArgv,
  appleNetworkInspectArgv,
  appleIsolateLinkDownArgv,
  appleIsolationCheckArgv,
  appleBrowserMcpArgv,
  browserMcpFlagsWithGateway,
  parseNetworkGateway,
  appleSystemStartArgv,
  appleKernelSetRecommendedArgv
} from '../apple-container-argv'
import { DEFAULT_BOX_LIMITS, browserMcpFlags, CONTAINER_USER, BOX_MOUNT, PLUGINS_MOUNT, BROWSER_MOUNT } from '../docker-argv'
const { ensureAppleBoxNetwork, boxNetworkGateway, setBoxNetworkGateway, appleContainerEngine } = await import('../apple-container-engine')

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

  it('NESSUN flag docker-only: --cap-drop, --security-opt, --init (il confine è la VM)', () => {
    const argv = runArgv('bridge').join(' ')
    expect(argv).not.toContain('--cap-drop')
    expect(argv).not.toContain('--security-opt')
    expect(argv).not.toContain('--init')
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
})

describe('BX2: il proxy del browser al GATEWAY della rete interna', () => {
  it('parseNetworkGateway: dal JSON dell\'inspect viene fuori l\'IPv4 del gateway', () => {
    expect(parseNetworkGateway('{"name":"homun-box","subnets":[{"subnet":"192.0.15.0/24","gateway":"192.0.15.1"}]}')).toBe('192.0.15.1')
    expect(parseNetworkGateway('gateway: 192.0.9.1')).toBe('192.0.9.1')
    expect(parseNetworkGateway('{}')).toBeNull()
    expect(parseNetworkGateway('gateway:.non.un.ip')).toBeNull()
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
  /** Runner finto: la rete manca alla PRIMA inspect, c'è dopo la create. */
  const fakeRun = (calls: string[][]) => async (argv: string[]) => {
    calls.push(argv)
    if (argv[0] === 'network' && argv[1] === 'inspect') {
      return calls.filter((c) => c[1] === 'create').length > 0
        ? { stdout: '{"subnets":[{"subnet":"192.0.15.0/24","gateway":"192.0.15.1"}]}', stderr: '', exitCode: 0 }
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
        return { stdout: '{"subnets":[{"gateway":"192.0.2.1"}]}', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const gw = await ensureAppleBoxNetwork(run)
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['network inspect'])
    expect(gw).toBe('192.0.2.1')
    setBoxNetworkGateway(null)
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
