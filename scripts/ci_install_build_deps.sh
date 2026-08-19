#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"

# GitHub-hosted Ubuntu runners sometimes resolve the generated Azure Ubuntu
# mirror but then hang while downloading Packages indexes. Keep the runner image
# defaults, but rewrite only that unstable Ubuntu mirror to the canonical archive
# before `apt-get update`.
apt_source_files=(
  /etc/apt/apt-mirrors.txt
  /etc/apt/sources.list
  /etc/apt/sources.list.d/*.sources
  /etc/apt/sources.list.d/*.list
)

for apt_source_file in "${apt_source_files[@]}"; do
  if [[ -f "$apt_source_file" ]]; then
    sudo sed -i \
      -e 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
      -e 's|https://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
      "$apt_source_file"
  fi
done

sudo apt-get \
  -o Acquire::Retries=2 \
  -o Acquire::http::Timeout=20 \
  -o Acquire::https::Timeout=20 \
  update
sudo apt-get install -y --no-install-recommends pkg-config libssl-dev
