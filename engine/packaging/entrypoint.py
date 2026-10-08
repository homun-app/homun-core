"""Frozen engine entrypoint; intentionally independent of source checkout paths."""
from multiprocessing import freeze_support
import sys

if __name__ == '__main__':
    freeze_support()
    if len(sys.argv) == 3 and sys.argv[1] == '_local-job-supervisor':
        from homun.execution.local_job_supervisor import supervise
        raise SystemExit(supervise(sys.argv[2]))
    from homun.__main__ import main
    raise SystemExit(main())
