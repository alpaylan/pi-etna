---
name: etna-report
description: Build a consistent summary report from all pipeline checkpoints
---

# Stage: Report

## Objective

Build `report.json` entirely from checkpoint data. No hand-authored summaries — all counters are derived from checkpoint array lengths.

## Execution Steps

1. Read all prior checkpoints with `etna_checkpoint_read`:
   - `candidates`, optional `expansion`, `ranked`, `fixes`, `classified`, `tests`, `mutations`, optional `tasks`, optional `commit`
2. Compute summary fields from checkpoint data:
   - `commits_scanned` = `expansion.total_commits_scanned` when expansion exists, else `candidates.total_commits_scanned`
   - `candidates_identified` = `candidates.candidates.length`
   - `fixes_extracted` = `fixes.count`
   - `mutations_classified` = `classified.count`
   - `mutations_injected` = `mutations.total_mutations`
   - `mutations_tested` = number of entries in `tests.variants`
   - `mutations_detected` = count of mutations where `detected === true`
   - `mutations_undetected` = count of mutations where `detected === false`
   - `mutations_final` = `mutations.mutations.length` (only detected ones)
   - `base_tests_passing` = `tests.base.passed`
3. Build `final_mutations` array with compact entries per mutation.
   - Include `canonical_trigger_case_test` whenever available (prefer failing tests whose names contain `case_`).
4. If `tasks.json` exists, include `summary.tasks_total = tasks.tasks.length` in report for workload task accounting.
5. If `expansion.json` exists, include a compact `expansion_summary` in report (commits scanned and frontportability stop decision).
6. Record `pipeline_stages` paths (including `tasks`/`commit` when present).
7. Write checkpoint with `etna_checkpoint_write`.

## Critical Rules

- **NEVER** hand-author numeric summaries
- **ALWAYS** derive counts from array lengths or checkpoint fields
- `mutations_undetected` must be 0 for a finalized workload
- Every `final_mutations` entry must reference a variant that exists in `mutations.json`
- `report.json` should include deterministic trigger-case mapping metadata (`canonical_trigger_case_test`) for final mutations whenever available

## Output Schema

```json
{
  "run_id": "<uuid>",
  "project": "<name>",
  "repo": "<repo url>",
  "language": "Rust",
  "summary": {
    "commits_scanned": 200,
    "candidates_identified": 20,
    "fixes_extracted": 13,
    "mutations_classified": 13,
    "mutations_deferred": 0,
    "mutations_injected": 27,
    "mutations_tested": 27,
    "mutations_detected": 27,
    "mutations_undetected": 0,
    "mutations_removed": 0,
    "mutations_final": 27,
    "base_tests_passing": true
  },
  "expansion_summary": {
    "total_commits_scanned": 500,
    "frontportability_stop": true,
    "stop_reason": "low frontportable yield across last two windows"
  },
  "pipeline_stages": {
    "candidates": "checkpoints/candidates.json",
    "ranked": "checkpoints/ranked.json",
    "fixes": "checkpoints/fixes.json",
    "classified": "checkpoints/classified.json",
    "tests": "checkpoints/tests.json",
    "mutations": "checkpoints/mutations.json"
  },
  "final_mutations": [
    {
      "name": "foo_wrong_operator",
      "file": "src/algo/foo.rs:42",
      "variant": "foo_wrong_operator_abc1234_1",
      "bug_type": "wrong-arithmetic-operator",
      "failing_tests": 1,
      "canonical_trigger_case_test": "property_public_foo_case_boundary"
    }
  ]
}
```
