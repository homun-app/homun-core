UV_ENV := .venv-mlx
PYTHON := $(UV_ENV)/bin/python
SERVER := runtimes/mlx-gemma4/server.py

.PHONY: sync test test-python test-rust test-browser browser-sync browser-test server health smoke-generate benchmark workflow-smoke

sync:
	UV_PROJECT_ENVIRONMENT=$(UV_ENV) uv sync

test: test-python test-browser test-rust

test-python:
	PYTHONDONTWRITEBYTECODE=1 $(PYTHON) -m unittest tests/test_mlx_gemma4_server.py

test-rust:
	cargo test --workspace

test-browser: browser-test

browser-sync:
	cd runtimes/browser-automation && npm install

browser-test:
	cd runtimes/browser-automation && npm test && npm run typecheck

server:
	$(PYTHON) $(SERVER)

health:
	curl -sS http://127.0.0.1:8765/health

smoke-generate:
	curl -sS http://127.0.0.1:8765/generate_json \
		-H 'Content-Type: application/json' \
		-d '{"prompt":"Rispondi solo JSON valido: {\"ok\": true}","required_keys":["ok"],"max_tokens":40}'

benchmark:
	PYTHONDONTWRITEBYTECODE=1 $(PYTHON) scripts/gemma4_benchmark.py

workflow-smoke:
	cargo run -p local-first-subagents --bin workflow_smoke
