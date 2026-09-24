# Evidence: H28/H29 cron durability (2026-09-24)

## Gap closed
- `CronManager` no longer keeps jobs/occurrences/incidents/deliveries only in module dicts.
- Durable store: `HOMUN_DATA_DIR/cron.sqlite` (override `HOMUN_CRON_DB`).
- Prompt/skills jobs without an injected agent runner fail with `backend_unavailable` (no synthetic success).
- Workspace isolation preserved on the same SQLite file.

## Commands
```bash
cd engine && python -m pytest tests/test_cron_jobs_and_scheduler.py -q
```

## Residual
- Chronos provider adapter still absent.
- Product agent_run dispatcher for due cron fires + real prompt runner wiring still open.
