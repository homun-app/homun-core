# Evidence: H12 checkpoint product wiring (2026-09-24)

## Gap closed
- Approved workspace writes (`workspace_file_edits._apply`) take a shadow checkpoint
  before mutation and record the agent write for selective rollback.
- Default store: `HOMUN_DATA_DIR/checkpoints`.
- Optional `delegation.worktree_isolation` creates/cleans a subagent git worktree.

Hermes treats checkpoints as infrastructure (not a model tool); Homun mirrors that.

## Commands
```bash
cd engine && .venv/bin/python -m pytest \
  tests/test_h12_product_wiring.py \
  tests/test_checkpoints_and_worktrees.py \
  tests/test_workspace_edits.py -q
```

## Residual
- Working-diff inspection tool for operators remains optional.
- Chronos / full rollback UX surfaces open.
