# Response Block Fixtures

**Source of truth for the cross-stack contract between Rust backend
(`src/tools/response_blocks.rs`) and Flutter client
(`homun-app/lib/features/chat/domain/models/chat_message_block.dart`).**

Each fixture is one canonical JSON payload per block type. Both the
Rust unit tests and the Flutter widget tests deserialize these files
and assert structural integrity. A schema drift in either stack breaks
at least one test suite, which is exactly the alarm we want.

## Files

- `choice.json` — `ChoiceBlock` with multiple options, metadata
- `approval.json` — `ApprovalBlock` with description + metadata
- `status.json` — `StatusBlock` with active state + fields
- `result.json` — `ResultBlock` with fields + icon
- `external_message.json` — `ExternalMessageBlock` with sender/subject/preview

## Sync

These files are duplicated in `homun-app/test/fixtures/blocks/`. The
duplication is intentional — cross-repo symlinks don't survive CI and
fancy build tooling adds drag. The two copies must stay byte-identical.

When editing any fixture:

1. Edit the file here first (source of truth)
2. Copy to `homun-app/test/fixtures/blocks/` with the same name
3. Run `cargo test response_blocks` and `flutter test` in homun-app
4. If either test suite diverges, the contract changed and both stacks
   need a coordinated update

## Adding a new block type

If `ResponseBlock` gains a new variant in `src/tools/response_blocks.rs`:

1. Add a fixture file here (`new_type.json`)
2. Add the fixture to the Rust `fixture_parity` test in `response_blocks.rs`
3. Add a corresponding Flutter parse test in `chat_message_block_test.dart`
4. Add the new field set to `chat_message_block.dart` (flat model)
5. Document the new variant in the block table above
