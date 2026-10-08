# Docker job backend implementation

- [x] RED tests for strict job contracts, isolated argv, durable start intent,
  ownership, restart/replay, scope symlinks, stop/remove and bounded CLI output.
- [x] execution/contracts.py typed immutable specs/errors/identity; cli.py bounded
  transport; docker.py backend lifecycle with no application imports or agent exposure.
- [x] Real cached Debian image, command writes a scoped file, nonzero process,
  background stop, new backend reconnect, no second effect, cleanup only fixtures.
- [x] Independent review, focused tests and architecture, docs/notice/local merge.
- [ ] Next tranche (not fulfilled by backend): product approvals, agent routing,
  durable job API/UI, files/artifacts, background watchdog, PTY/stdin.
