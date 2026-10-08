#!/usr/bin/env python3
"""Build a standalone engine using fresh, hash-locked build dependencies.

Native builds only (PyInstaller does not cross-compile): validated host
targets are macOS arm64, Linux x86_64 and Windows AMD64, each on its own
runner. ``--cua-driver`` copies a pre-verified driver binary into the
bundle (engine/bin/) so the receipt inventory pins it like every other
artifact.
"""
import argparse
import hashlib
import json
import os
import platform
import stat
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# ELF program-header identifiers for the execstack hardening below.
PT_GNU_STACK = 0x6474E551
PF_X = 0x1

# Native build targets: PyInstaller bundles for the host, never cross-compiles.
HOST_TARGETS = {
    ('Darwin', 'arm64'): {'os': 'mac', 'target_arch': 'arm64'},
    ('Linux', 'x86_64'): {'os': 'linux', 'target_arch': 'none'},
    ('Windows', 'AMD64'): {'os': 'win', 'target_arch': 'none'},
}


def run(*args, cwd=ROOT):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def artifact_inventory(root):
    """Bind receipt to every generated file; never follow an escaping symlink."""
    root = root.resolve()
    inventory = []
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if name == 'build-receipt.json':
            continue
        if '\\' in name or '..' in Path(name).parts or Path(name).is_absolute():
            raise ValueError('Non-canonical bundle artifact name')
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            target = os.readlink(path)
            if not path.resolve().is_relative_to(root) or not path.exists():
                raise ValueError('Bundle symlink escapes or has no target: ' + name)
            inventory.append({'name': name, 'symlink': target})
        elif stat.S_ISREG(mode):
            inventory.append({'name': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        elif not stat.S_ISDIR(mode):
            raise ValueError('Unsupported bundle artifact: ' + name)
    return inventory


def clear_execstack(image):
    """Return ``image`` with PF_X cleared on PT_GNU_STACK, or None when untouched.

    glibc >= 2.39 refuses to dlopen objects that request an executable stack,
    and some interpreters still request one: python-build-standalone releases
    cut around March 2026 ship libpython with a RWE GNU_STACK (LLVM 22 stopped
    emitting .note.GNU-stack; fixed upstream by python-build-standalone#1064).
    Raises ValueError for ELF images whose program headers cannot be located.
    """
    if len(image) < 64 or image[:4] != b'\x7fELF':
        return None
    endian = {1: '<', 2: '>'}.get(image[5])
    if endian is None:
        raise ValueError('unknown ELF byte order')
    if image[4] == 2:
        phoff, = struct.unpack_from(endian + 'Q', image, 0x20)
        phentsize, phnum = struct.unpack_from(endian + 'HH', image, 0x36)
        flags_at = 4
    elif image[4] == 1:
        phoff, = struct.unpack_from(endian + 'I', image, 0x1C)
        phentsize, phnum = struct.unpack_from(endian + 'HH', image, 0x2A)
        flags_at = 24
    else:
        raise ValueError('unknown ELF class')
    if phnum == 0xFFFF:
        raise ValueError('extended program header count is unsupported')
    patched = None
    for index in range(phnum):
        entry = phoff + index * phentsize
        if entry + phentsize > len(image):
            raise ValueError('program header table outside the file')
        if struct.unpack_from(endian + 'I', image, entry)[0] != PT_GNU_STACK:
            continue
        flags = struct.unpack_from(endian + 'I', image, entry + flags_at)[0]
        if not flags & PF_X:
            continue
        if patched is None:
            patched = bytearray(image)
        struct.pack_into(endian + 'I', patched, entry + flags_at, flags & ~PF_X)
    return bytes(patched) if patched is not None else None


def clear_bundle_execstack(root):
    """Clear executable GNU_STACK on every regular ELF under ``root``.

    Returns the names of patched files; the caller re-verifies before
    distribution because a bundle that still requests execstack is dead on
    arrival on current glibc (engine dlopen fails, app exits).
    """
    patched = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            replacement = clear_execstack(path.read_bytes())
        except ValueError as error:
            raise ValueError(f'Unparseable ELF in bundle: {path.name}: {error}')
        if replacement is not None:
            path.write_bytes(replacement)
            patched.append(path.relative_to(root).as_posix())
    for name in patched:
        if clear_execstack((root / name).read_bytes()) is not None:
            raise ValueError(f'Executable GNU_STACK survived patching: {name}')
    return patched


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python', default='3.13.12', help='Build interpreter; bundled runtime does not require it')
    parser.add_argument('--cua-driver', default=None,
                        help='Pre-verified cua-driver binary to bundle into engine/bin/')
    args = parser.parse_args()
    target = HOST_TARGETS.get((platform.system(), platform.machine()))
    if target is None:
        raise SystemExit('Unsupported build host: native targets are '
                         'macOS arm64, Linux x86_64, Windows AMD64')
    uv = shutil.which('uv')
    if not uv:
        raise SystemExit('uv is required only on the build host')
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    def engine_inputs():
        sources = sorted((ROOT / 'engine/src/homun').rglob('*.py'))
        prompts = sorted((ROOT / 'engine/src/homun').rglob('*.txt'))
        return sources, prompts

    sources, prompt_files = engine_inputs()
    input_paths = sources + prompt_files + [
        ROOT / name for name in ('engine/requirements.lock', 'engine/requirements-packaging.lock',
                                  'engine/packaging/homun-engine.spec', 'engine/packaging/entrypoint.py',
                                  'engine/pyproject.toml', 'tools/build_engine_bundle.py')]
    inputs = {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in input_paths}
    with tempfile.TemporaryDirectory(prefix='homun-engine-build-') as directory:
        build = Path(directory)
        venv = build / 'venv'
        python = venv / ('Scripts/python.exe' if target['os'] == 'win' else 'bin/python')
        run(uv, 'venv', '--python', args.python, venv)
        python_version = subprocess.check_output([str(python), '-c', 'import platform; print(platform.python_version())'], text=True).strip()
        if python_version != '3.13.12':
            raise SystemExit('The validated build interpreter is CPython 3.13.12')
        run(uv, 'pip', 'install', '--python', python, '--require-hashes',
            '-r', ROOT / 'engine/requirements.lock', '-r', ROOT / 'engine/requirements-packaging.lock')
        run(uv, 'pip', 'install', '--python', python, '--no-deps', '--no-build-isolation', ROOT / 'engine')
        # A failed replacement build must never retain an earlier valid receipt.
        (dist / 'engine/build-receipt.json').unlink(missing_ok=True)
        env = {**os.environ, 'HOMUN_TARGET_ARCH': target['target_arch']}
        subprocess.run([str(python), '-m', 'PyInstaller', '--noconfirm', '--clean',
                        '--distpath', str(dist), '--workpath', str(build / 'work'),
                        str(ROOT / 'engine/packaging/homun-engine.spec')],
                       cwd=ROOT, check=True, env=env)
    if args.cua_driver:
        driver = Path(args.cua_driver).expanduser().resolve()
        if not driver.is_file():
            raise SystemExit(f'cua-driver binary not found: {driver}')
        bundled = dist / 'engine' / 'bin' / ('cua-driver.exe' if target['os'] == 'win' else 'cua-driver')
        bundled.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(driver, bundled)
        bundled.chmod(bundled.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    if target['os'] == 'linux':
        try:
            hardened = clear_bundle_execstack(dist / 'engine')
        except ValueError as error:
            raise SystemExit(f'Engine bundle execstack hardening failed: {error}')
        if hardened:
            print('Cleared executable GNU_STACK on: ' + ', '.join(hardened))
    current_sources = {path.relative_to(ROOT).as_posix()
                       for path in (ROOT / 'engine/src/homun').rglob('*.py')}
    current_sources |= {path.relative_to(ROOT).as_posix()
                        for path in (ROOT / 'engine/src/homun').rglob('*.txt')}
    expected_sources = {name for name in inputs if name.startswith('engine/src/')}
    if current_sources != expected_sources or any(
        not (ROOT / name).is_file() or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest
        for name, digest in inputs.items()
    ):
        raise SystemExit('Build inputs changed during packaging; rebuild before distribution')
    source_hash = hashlib.sha256()
    for path in sorted(sources + prompt_files):
        source_hash.update(path.relative_to(ROOT / 'engine/src').as_posix().encode() + b'\0' + path.read_bytes())
    receipt = {'artifact_files': artifact_inventory(dist / 'engine'),
               'source_sha256': source_hash.hexdigest(),
               'build_inputs': {name: digest for name, digest in inputs.items() if not name.startswith('engine/src/') and not name.endswith('.lock')},
               'platform': platform.platform(), 'architecture': platform.machine(), 'python_version': python_version, 'inputs': inputs,
               'memory_profile': 'sqlite-only; optional Mem0 excluded',
               'locks': {name: hashlib.sha256((ROOT / 'engine' / name).read_bytes()).hexdigest()
                         for name in ('requirements.lock', 'requirements-packaging.lock')}}
    (dist / 'engine/build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    engine_exe = dist / 'engine' / ('homun-engine.exe' if target['os'] == 'win' else 'homun-engine')
    print(engine_exe)


if __name__ == '__main__':
    main()
