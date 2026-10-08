# Evidence: H32 gateway pairing durability (2026-09-24)

## Gap closed
- `GatewayPairingManager` persists codes, allowlist, lockouts, and rate state in
  `HOMUN_DATA_DIR/gateway/pairing-<workspace>.sqlite` (override `HOMUN_PAIRING_DB`).
- Approval/revoke survive process reopen.

## Commands
```bash
cd engine && .venv/bin/python -m pytest tests/test_gateway_and_channels.py -q
```

## Residual
- Turn leases remain process-local (intentional serialization).
- Hosted rooms still in-memory; Chronos still absent.
