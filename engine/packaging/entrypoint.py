"""Frozen engine entrypoint; intentionally independent of source checkout paths."""
from multiprocessing import freeze_support
from homun.__main__ import main

if __name__ == '__main__':
    freeze_support()
    raise SystemExit(main())
