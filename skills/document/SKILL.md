---
name: document
description: Regenerate BUGS.md and TASKS.md via `etna workload doc` — docs are derived, never hand-edited
---

# Stage: Document

## Objective

`BUGS.md` and `TASKS.md` are derived artefacts. `etna workload doc <dir>` reads `etna.toml` and writes both files deterministically. This stage's entire job is to run that command and confirm no drift. etna-cli is the renderer — do not hand-author these files.

## Procedure

1. `etna workload doc <project>` — exit 0 required. Writes `<project>/BUGS.md` and `<project>/TASKS.md`.
2. `git -C <project> diff --exit-code BUGS.md TASKS.md` — if nonzero, the manifest changed since the last regeneration (expected during active atomize work); stage the updated files into the atomize commit. Nonzero diff *after* a clean atomize+document pass on an already-generated workload is a defect — investigate `etna workload doc` idempotence.

## Invariants

- `etna.toml` is the single source of truth. `BUGS.md` and `TASKS.md` are regenerated; never hand-edited.
- `etna workload doc` is idempotent — running it twice produces identical output. This is enforced by the `docs_idempotent` check in `etna workload check`.
- The pre-commit hook on every workload runs `etna workload check .`, which re-runs the doc generator and fails on any drift. Hand-edits to the docs get caught at commit time.

## Diagnosing unexpected output

- **Variant missing from the Bug Index** → its `[[tasks]]` block is malformed or missing in `etna.toml`. Read etna-cli stderr for the parse error.
- **Witness rows missing from TASKS.md** → the `[[tasks.tasks]].witnesses` array is empty, or uses the `Input { input = ... }` variant instead of `TestFn { test_fn = ... }` (see the `Witness` enum in `etna2/src/workload.rs` near line 403).
- **PascalCase property silently becomes garbage snake_case** → check `pascal_to_snake` maps correctly (`etna2/src/commands/workload/check.rs:307` + unit tests at `:320`). A manifest property of `"X"` maps to `"x"`; ensure the Rust function exists under that exact name.
- **Dropped candidates not appearing** → `[[dropped]]` is a **top-level** block, not nested under `[[tasks]]`. Every dropped block needs `commit` and `reason` (`subject` is optional).

## Progress events

Emit to `<project>/progress.jsonl` per the contract in `prompts/run.md`:

| When                                 | Event line                                                                 |
|--------------------------------------|----------------------------------------------------------------------------|
| Starting document stage              | `{"stage":"document","event":"start"}`                                     |
| `BUGS.md` written                    | `{"stage":"document","event":"bugs_written","variants":N}`                 |
| `TASKS.md` written                   | `{"stage":"document","event":"tasks_written","tasks":M}`                   |
| Document stage complete              | `{"stage":"document","event":"done"}`                                      |

These fire around the `etna workload doc` invocation rather than hand-rolled rendering. Derive `variants` from `len(manifest.tasks)` and `tasks` from a line count of the TASKS.md Task Index.
