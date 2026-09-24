# Evidence: H32 hosted rooms durability + cron agent runner (2026-09-24)

## Gap closed
- `HostedRoomManager` persists rooms and append-only events under
  `HOMUN_DATA_DIR/gateway/rooms-<workspace>.sqlite` (override `HOMUN_ROOMS_DB`).
- `cronjob_manage` `run` stages real agent-run proposals via `CronAgentRunner`
  when EngineContext is present; otherwise remains honest failure.

## Commands
```bash
cd engine && .venv/bin/python -m pytest \
  tests/test_gateway_and_channels.py \
  tests/test_cron_jobs_and_scheduler.py -q
```
