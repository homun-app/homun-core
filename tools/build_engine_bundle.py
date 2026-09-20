#!/usr/bin/env python3
"""Build a standalone arm64 engine using fresh, hash-locked build dependencies."""
import argparse
import hashlib
import json
import os
import stat
import platform
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python', default='3.13.12', help='Build interpreter; bundled runtime does not require it')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('This packaging target requires a macOS arm64 build host')
    uv = shutil.which('uv')
    if not uv:
        raise SystemExit('uv is required only on the build host')
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    def engine_inputs():
        sources = sorted((ROOT / 'engine/src/homun').rglob('*.py'))
        prompts = sorted((ROOT / 'engine/src/homun/prompts').rglob('*.txt'))
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
        python = venv / 'bin/python'
        run(uv, 'venv', '--python', args.python, venv)
        python_version = subprocess.check_output([str(python), '-c', 'import platform; print(platform.python_version())'], text=True).strip()
        if python_version != '3.13.12':
            raise SystemExit('The validated build interpreter is CPython 3.13.12')
        run(uv, 'pip', 'install', '--python', python, '--require-hashes',
            '-r', ROOT / 'engine/requirements.lock', '-r', ROOT / 'engine/requirements-packaging.lock')
        run(uv, 'pip', 'install', '--python', python, '--no-deps', '--no-build-isolation', ROOT / 'engine')
        # A failed replacement build must never retain an earlier valid receipt.
        (dist / 'engine/build-receipt.json').unlink(missing_ok=True)
        run(python, '-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', dist,
            '--workpath', build / 'work', ROOT / 'engine/packaging/homun-engine.spec')
    current_sources = {path.relative_to(ROOT).as_posix()
                       for path in (ROOT / 'engine/src/homun').rglob('*.py')}
    current_sources |= {path.relative_to(ROOT).as_posix()
                        for path in (ROOT / 'engine/src/homun/prompts').rglob('*.txt')}
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
    print(dist / 'engine/homun-engine')


if __name__ == '__main__':
    main()
