---
name: etna-validation
description: Validate cross-checkpoint consistency and produce pass/fail report
---

# Stage: Validation

## Objective

Run strict consistency checks across all checkpoint files and the generated documentation. This is the final gate before a workload is considered complete.

## Execution Steps

1. Use `etna_pipeline_gate_check` with `gate: "source_commit"` to verify each mutation's source commit matches the extracted fix sites. Additive-only fixes are valid when fixed snippets are present in added lines (no matching removed snippet required for that site).
2. Use `etna_pipeline_gate_check` with `gate: "trigger_cases"` to verify each final mutation has a deterministic property trigger-case test mapping.
3. Use `etna_pipeline_gate_check` with `gate: "frontportability_stop"` to verify below-target workloads have a justified STOP decision after expansion.
4. Use `etna_pipeline_gate_check` with `gate: "cross_checkpoint"` for the automated invariant checks.
5. Additionally verify:
   - BUGS.md exists and contains entries for every final mutation (mutation catalog)
   - tasks.json exists and contains mutation/property/witness triplets for final mutations (first-class stage output)
   - commit.json exists and records one-per-mutation commit metadata (branch, commit, base_commit)
   - commit stage is not a placeholder (no "not materialized yet" / pending-only commit output)
   - TASKS.md exists and documents those tasks for humans
   - `marauder.toml` exists in the project directory
   - Mutation source files still contain valid marauders comment syntax
   - `etna_marauders_list` returns all expected mutations
   - File paths in BUGS.md match the full paths in mutations.json (e.g., `roaring/src/bitmap/store/bitmap_store.rs:575`, not just `bitmap_store.rs:575`)
   - Mutation count policy: if below minimum target, `expansion.frontportability_stop` must justify that further mining is unlikely to yield frontportable bugs; otherwise continue expansion
   - tests.json has `base.passed == true` and no variant placeholders such as `blocked_by_base`/`not_run`
   - mutations.json removal reasons are terminal outcomes, not temporary blockers (e.g., not "not injected yet")
6. **CRITICAL: Write `validation.json` checkpoint** using `etna_checkpoint_write` with stage "validation". This checkpoint is REQUIRED — the pipeline is not complete without it. The validation stage must always produce a checkpoint, even if validation fails.

## Invariants Checked

These are the invariants from the pipeline specification:

1. `report.summary.candidates_identified == len(candidates.candidates)`
2. `report.summary.mutations_final == len(report.final_mutations)`
3. Every mutation in `report.final_mutations` exists in `mutations.json` by variant
4. Every failing test in `report.final_mutations` exists in `tests.json`
5. Every removed mutation has a reason and does not appear in final mutations
6. `report.summary.mutations_undetected == 0`
7. Every final mutation has at least one failing regression test in `tests.json`
8. Every final mutation has a canonical failing property test in `docs.json`
9. Every final mutation variant appears in BUGS.md
10. tasks.json and TASKS.md contain mutation/property/witness triplets and trigger-case references for final mutations
11. commit.json maps each final mutation to a commit and all entries share a single base_commit (parallel branches)
12. All checkpoints share the same `run_id`
13. Every mutation source commit matches extracted fix evidence in `fixes.json` (fixed snippet in added lines; removed-snippet match required unless the site is additive-only) via `source_commit` gate
14. Every final mutation has a deterministic property trigger-case test mapping (via `trigger_cases` gate)
15. Below-target workloads have expansion STOP justification via `frontportability_stop` gate
16. tests.json indicates a real executed test run (`base.passed == true`, no `blocked_by_base`/`not_run` placeholders)
17. mutations.json removed reasons are terminal outcomes, not transitional blockers (no "not injected yet" placeholders)
18. commit.json is not a placeholder-only artifact (no "not materialized yet" note)

## Output Schema

```json
{
  "run_id": "<uuid>",
  "project": "<name>",
  "passed": true,
  "checks": {
    "candidates_count_match": true,
    "mutations_final_count_match": true,
    "all_final_mutations_in_mutations_json": true,
    "all_final_mutations_in_tests_json": true,
    "no_undetected_mutations": true,
    "all_mutations_have_failing_tests": true,
    "all_mutations_have_property_detectors": true,
    "all_mutations_in_bugs_md": true,
    "consistent_run_ids": true,
    "marauders_list_matches": true
  },
  "mismatches": []
}
```

## On Failure

If any check fails:
- The pipeline status should be set to "failed" via `etna_pipeline_advance` with `action: "fail"`
- The mismatch report should clearly identify which checks failed and why
- Do NOT mark the workload as complete
- Provide actionable guidance on which earlier stage needs correction
