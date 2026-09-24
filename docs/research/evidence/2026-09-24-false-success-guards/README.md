# Evidence: Phase 1 false-success guards (2026-09-24)

Hermes pin: `c9dca726514b709cf6e677d236a79fc8d0627f37`
Homun base: `5be85c01bf5e5472252ebf7ac4ba8074fce172e7`

## What changed

Product defaults no longer invent success for H41 media, H16 computer-use,
H33 channel send, H35 hosted MCP, H39 Copilot ACP, H43 Yuanbao/Meet, or H45
batch eval when a real backend is missing.

Contract: typed `backend_unavailable` / explicit failure; injectable providers
for tests and real backends only.

## Verification

```bash
cd engine && PYTHONPATH=src .venv/bin/python -m pytest \
  tests/test_false_success_guards.py \
  tests/test_h41_media.py \
  tests/test_h16_desktop.py \
  tests/test_h43_integrations.py \
  tests/test_h45_research.py \
  tests/test_h35_protocols.py \
  tests/test_h39_runtimes.py \
  tests/test_gateway_and_channels.py -q
# 66 passed
```

## Residual (not parity)

Real provider backends, OS driver, channel transports, Meet browser join,
and product wiring remain open. Honesty-only is not completion.
