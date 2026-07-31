# CoderSteroids Helpers

This folder contains lightweight helper artifacts exported from CoderSteroids.

## Field Depth Report

Use the template:

```bash
docs/codersteroids/field-depth-report-template.md
```

Validate a completed field-depth report with:

```bash
scripts/codersteroids/check-field-depth-report.sh path/to/report.md
```

The checker validates report structure only. It does not prove the analysis is correct.
It requires an observability/logging plan so runtime claims are grounded in logs,
metrics, traces, profiles, benchmark reports, or explicit instrumentation gaps.
