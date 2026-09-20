#!/usr/bin/env python3
"""Export the current engine API without starting its lifespan or database.

Run with engine/.venv/bin/python locally, or the installed engine Python in CI.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / 'contracts' / 'openapi' / 'v1-engine.json'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Fail if the committed snapshot differs')
    mode.add_argument('--write', action='store_true', help='Write the snapshot (default)')
    args = parser.parse_args()

    # Explicit source path prevents exporting another installed engine checkout.
    sys.path.insert(0, str(ROOT / 'engine' / 'src'))
    from homun.app import create_app

    # Factory/schema generation does not enter lifespan or obtain a context.
    content = json.dumps(create_app().openapi(), ensure_ascii=False, indent=2, sort_keys=True) + '\n'
    if args.check:
        if not SNAPSHOT.exists() or SNAPSHOT.read_text(encoding='utf-8') != content:
            print('OpenAPI snapshot is stale. Run: engine/.venv/bin/python tools/export_openapi.py --write', file=sys.stderr)
            return 1
        print('OpenAPI snapshot matches current engine routes.')
        return 0
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(content, encoding='utf-8')
    print(f'Wrote {SNAPSHOT.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
