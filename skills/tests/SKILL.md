---
name: etna-tests
description: Map mutations to regression and property-based detector tests, execute validation
---

# Stage: Tests

## Objective

For each expressible mutation, identify existing property-based tests (PBTs) that cover the buggy code, plan regression tests, and run validation to confirm detection. This is the most complex and iterative stage.

## Execution Steps

### 5a: Assess Existing Tests

1. Read the classified checkpoint with `etna_checkpoint_read` (stage: "classified").
2. Explore the project's test files using Pi's built-in `read` tool to find:
   - Property-based test files (look for proptest, quickcheck, crabcheck imports)
   - Unit test modules
   - Integration test files in `tests/`
3. For each mutation, determine which existing tests cover the relevant code.

### 5b: Run Base Tests

4. Use `etna_cargo_test_base` to run all tests and confirm the base (fixed) version passes.
5. Record base test results.
6. If base tests fail due environment/toolchain/workspace setup (not due a mutation), STOP and treat this stage as blocked. Do **not** proceed to mutations/commit; fix the execution context first (toolchain override, workspace root, package filter, etc.).

### 5c: Run Variant Tests

7. For each mutation variant, use `etna_cargo_test_variant` to check if existing tests detect the bug.
8. If a variant has no failing tests, note it — the mutation stage may need to add targeted tests or remove the mutation.
9. Record per-variant: `passed`, `exit_code`, `duration_seconds`, `failing_tests`, `failure_type`.

**Important**: Before running variant tests, mutations must be in functional syntax. Use `etna_marauders_convert` with `to: "functional"` on files containing mutations.

### 5d: Plan Additional Tests

10. For mutations not detected by existing tests, plan:
   - **Regression test**: a concrete, non-parameterized test that reproduces the exact bug
   - **Property-based test**: a parameterized test capturing the violated property
11. For property-based detectors, add at least one deterministic trigger-case test (recommended naming: `*_case_*`) so detection is reproducible and can be validated by the `trigger_cases` gate.

## Output Schema

```json
{
  "run_id": "<uuid>",
  "project": "<name>",
  "base": {
    "passed": true,
    "exit_code": 0,
    "duration_seconds": 37.77,
    "mode": "debug"
  },
  "variants": {
    "foo_wrong_operator_abc1234_1": {
      "passed": false,
      "exit_code": 101,
      "duration_seconds": 6.21,
      "failures": 1,
      "failing_tests": ["tests::test_foo_correctness"],
      "failure_type": "wrong operator causes incorrect result for negative inputs"
    }
  }
}
```

## Quality Criteria

- Base tests must pass (exit_code 0) — stop if they don't
- A completed tests stage must not contain placeholder statuses like `blocked_by_base`/`not_run` for variants
- Every variant should be tested, even if expected to pass
- `failing_tests` lists specific test names, not just counts
- `failure_type` is a human-readable description of how the bug manifests
- Variants that pass (undetected) are recorded with `passed: true` — they're candidates for removal or additional test writing in the mutations stage
