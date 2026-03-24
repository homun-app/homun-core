#!/usr/bin/env bash

set -euo pipefail

config_args=()
if [[ -n "${PLAYWRIGHT_CLI_CONFIG:-}" ]]; then
    config_args+=(--config "$PLAYWRIGHT_CLI_CONFIG")
fi

npx --yes --package @playwright/cli playwright-cli "${config_args[@]}" "$@"
