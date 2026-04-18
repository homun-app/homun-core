#!/bin/bash
# Setup self-hosted CI runner for homun-core in Docker on a Mac dev machine.
#
# Usage: ./scripts/setup-ci-runner.sh
# Prereqs: Docker Desktop running, `gh` CLI authenticated with `repo` scope.
#
# What this does:
#   1. Removes any existing runner (Docker container + GitHub registration)
#   2. Gets a fresh runner registration token from GitHub
#   3. Starts a fresh Docker container — native ARM64 (no Rosetta) on Apple Silicon
#   4. Installs gcc-13 + g++-13 inside the container (required by usearch/simsimd)
#
# After this script: CI for PRs runs free on your Mac via the self-hosted runner.

set -euo pipefail

REPO_OWNER="homun-app"
REPO_NAME="homun-core"
RUNNER_NAME="mac-fabio"
WORKDIR="${HOME}/.homun-runner/work"

echo "==> Stopping any existing runner container..."
docker stop homun-runner 2>/dev/null || true
docker rm homun-runner 2>/dev/null || true

echo "==> Deregistering any existing runner from GitHub..."
RUNNER_ID=$(gh api "/repos/${REPO_OWNER}/${REPO_NAME}/actions/runners" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(r['id']) for r in d.get('runners', []) if r['name'] == '${RUNNER_NAME}']")
if [ -n "$RUNNER_ID" ]; then
  gh api -X DELETE "/repos/${REPO_OWNER}/${REPO_NAME}/actions/runners/${RUNNER_ID}"
  echo "    Deregistered runner ID $RUNNER_ID"
fi

echo "==> Cleaning workspace..."
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

echo "==> Getting fresh registration token..."
RUNNER_TOKEN=$(gh api -X POST "/repos/${REPO_OWNER}/${REPO_NAME}/actions/runners/registration-token" -q .token)

echo "==> Starting Docker container (native ARM64)..."
docker run -d \
  --name homun-runner \
  --restart unless-stopped \
  -e REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}" \
  -e RUNNER_NAME="${RUNNER_NAME}" \
  -e RUNNER_TOKEN="${RUNNER_TOKEN}" \
  -e RUNNER_WORKDIR="/tmp/runner/work" \
  -e LABELS="self-hosted,linux,docker,homun-mac" \
  -e RUNNER_SCOPE="repo" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${WORKDIR}:/tmp/runner/work" \
  myoung34/github-runner:latest

echo "==> Waiting for runner to come up..."
sleep 8

echo "==> Installing gcc-13/g++-13 (required by usearch/simsimd intrinsics)..."
docker exec homun-runner bash -c "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq software-properties-common
  add-apt-repository -y ppa:ubuntu-toolchain-r/test
  apt-get update -qq
  apt-get install -y -qq gcc-13 g++-13
  update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-13 100
  update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-13 100
  update-alternatives --install /usr/bin/cc cc /usr/bin/gcc-13 100
  update-alternatives --install /usr/bin/c++ c++ /usr/bin/g++-13 100
"

echo "==> Done. Runner status:"
docker exec homun-runner gcc --version | head -1
gh api "/repos/${REPO_OWNER}/${REPO_NAME}/actions/runners" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f\"    {r['name']}: {r['status']} labels={[l['name'] for l in r['labels']]}\") for r in d.get('runners', [])]"

echo ""
echo "✅ Runner ready. CI will use it on next push/PR."
echo ""
echo "Useful commands:"
echo "  docker logs -f homun-runner       # tail runner logs"
echo "  docker restart homun-runner       # restart"
echo "  docker stop homun-runner          # stop"
