#!/usr/bin/env bash
set -u

if test "$#" -ne 1; then
  echo "Usage: ./scripts/check-field-depth-report.sh path/to/report.md"
  exit 1
fi

file="$1"
failures=0

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  failures=$((failures + 1))
  printf 'FAIL %s\n' "$1"
}

if ! test -f "$file"; then
  echo "Missing field-depth report: $file"
  exit 1
fi

required_headings=(
  "## Local Flow Map"
  "## Observability And Logging Plan"
  "## Primary Hypotheses"
  "## Secondary Bottlenecks"
  "## Implementation Library Research"
  "## Falsification Checks"
  "## Affected Verification Matrix"
  "## Decision And Next Step"
  "## Durable Memory Updates"
)

for heading in "${required_headings[@]}"; do
  if grep -qx "$heading" "$file"; then
    pass "found heading: $heading"
  else
    fail "missing heading: $heading"
  fi
done

if grep -q '| Slice | Command or inspection | Proves | Status |' "$file"; then
  pass "verification matrix header present"
else
  fail "verification matrix header missing"
fi

if grep -q '| Signal | Source | Proves | Gap | Action |' "$file"; then
  pass "observability matrix header present"
else
  fail "observability matrix header missing"
fi

if grep -qi 'falsif' "$file"; then
  pass "falsification language present"
else
  fail "report does not mention falsification"
fi

printf '\nSummary: %s failure(s)\n' "$failures"

if test "$failures" -gt 0; then
  exit 1
fi
