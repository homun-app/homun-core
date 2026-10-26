// Costruzione degli argv per la CLI docker — funzioni PURE (§5.2).
// Mai comandi docker assemblati come stringa e passati a una shell dell'host:
// ogni chiamata è spawn('docker', argv) con argv array. Path, comandi e opzioni
// restano singoli elementi argv: niente interpolazione, niente quoting da
// aggirare, niente escape possibile.
export const BOX_WORKDIR = '/home/box'

/** Utente non-root del container (ubuntu:24.04 → uid/gid 1000). */
export const CONTAINER_USER = '1000:1000'

export interface DockerExecOptions {
  workdir?: string
  /** Variabili da iniettare nel container: chiave qui, VALORE nell'env del processo docker spawnato (`-e KEY` senza `=valore` eredita dall'ambiente). */
  env?: Record<string, string>
}

/** `docker exec -i -w /home/box [-e KEY …] <container> sh -c <command>` — il comando del modello resta un unico elemento argv. */
export function dockerExecArgv(container: string, command: string, opts: DockerExecOptions = {}): string[] {
  const argv = ['exec', '-i', '-w', opts.workdir ?? BOX_WORKDIR]
  for (const key of Object.keys(opts.env ?? {})) argv.push('-e', key)
  argv.push(container, 'sh', '-c', command)
  return argv
}

/** Lettura file: il path è un argomento di cat, mai shell. */
export function dockerReadFileArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_WORKDIR, container, 'cat', '--', path]
}

/**
 * Scrittura byte-exact (§5.2): la stringa `sh -c` è COSTANTE — il path entra
 * come argomento posizionale ($1) e il contenuto arriva via stdin, quindi
 * `cat > "$1"` scrive esattamente i byte ricevuti (niente newline finale
 * aggiunto, nessun marker tipo SANDBOT_EOF che possa comparire nel contenuto).
 */
export const DOCKER_WRITE_SH = 'mkdir -p "$(dirname "$1")" && cat > "$1"'

export function dockerWriteFileArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_WORKDIR, container, 'sh', '-c', DOCKER_WRITE_SH, 'sh', path]
}

export function dockerListDirArgv(container: string, path: string): string[] {
  return ['exec', '-i', '-w', BOX_WORKDIR, container, 'ls', '-la', '--', path]
}

/** Esistenza per nome esatto: filtro con anchor regex, niente `| grep` su stringhe. */
export function dockerPsArgv(container: string): string[] {
  return ['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^/${container}$`]
}

export function dockerStartArgv(container: string): string[] {
  return ['start', container]
}

/** Hardening del container a creazione (§5.2): non-root, cap-drop, no-new-privs, limiti. */
export function dockerCreateArgv(container: string, volume: string, network: 'bridge' | 'none'): string[] {
  return [
    'create',
    '--name', container,
    '--user', CONTAINER_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
    '--memory', '2g',
    '--cpus', '2',
    '--network', network,
    '-v', `${volume}:/home/box`,
    '-w', '/home/box',
    '-i',
    'ubuntu:24.04',
    'sleep', 'infinity'
  ]
}

/**
 * Init del volume alla prima creazione: il volume appena montato è di root,
 * ma il container gira non-root con --cap-drop ALL (root senza CAP_CHOWN non
 * può chownare). Un one-shot con la stessa immagine, root e senza hardening,
 * sistema la proprietà una volta sola.
 */
export function dockerVolumeChownArgv(volume: string): string[] {
  return ['run', '--rm', '-v', `${volume}:/home/box`, 'ubuntu:24.04', 'chown', '-R', CONTAINER_USER, '/home/box']
}
