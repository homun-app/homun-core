# macOS arm64 onedir bundle. No optional Mem0/Qdrant memory profile.
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules, collect_data_files, copy_metadata

root = Path(SPECPATH)
datas, binaries, hiddenimports = [], [], []
for package in ('homun', 'dbos', 'uvicorn'):
    package_data, package_binaries, package_imports = collect_all(package)
    datas += package_data
    binaries += package_binaries
    hiddenimports += package_imports
# Logfire's installed Pydantic plugin inspects validator source at import time.
for package in ('pydantic', 'logfire'):
    datas += collect_data_files(package, include_py_files=True)
hiddenimports += collect_submodules('pydantic_ai.models')
hiddenimports += collect_submodules('pydantic_ai.providers')
for distribution in ('homun-engine', 'dbos', 'pydantic-ai', 'pydantic-ai-slim', 'uvicorn'):
    datas += copy_metadata(distribution, recursive=True)
a = Analysis([str(root / 'entrypoint.py')], pathex=[], binaries=binaries, datas=datas,
             hiddenimports=hiddenimports, hookspath=[], runtime_hooks=[],
             excludes=['mem0', 'qdrant_client', 'pytest', 'tkinter'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='homun-engine',
          debug=False, strip=False, upx=False, console=True, target_arch='arm64',
          codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='engine')
