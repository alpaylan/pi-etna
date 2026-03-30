---
name: etna-mutations
description: Inject marauders mutations into source code and verify detection via tests
---

# Stage: Mutations

## Objective

For each classified and tested candidate, inject a marauders mutation in comment syntax that recreates the bug. Verify detection. Produce the final list of retained mutations.

## Execution Steps

### Prerequisites

0. **Ensure marauder.toml exists**: Run `etna_marauders_init` if the project does not already have a `marauder.toml`. This is REQUIRED before injecting any mutations or using `etna_marauders_list`/`etna_marauders_convert`.

### Inject Mutations

1. Read the classified and tests checkpoints.
2. For each expressible mutation:
   a. Use Pi's `edit` tool to inject marauders comment-syntax mutations into source files.
   b. If a logical bug spans multiple files/hunks, inject all sites with the **same variant name** so one variant activation recreates the full bug.
   c. Follow the marauders comment syntax format:
      ```rust
      /*| <mutation_name> [<tags>] */
      <fixed_code (base)>
      /*|| <variant_name> */
      /*|
      <buggy_code (variant)>
      */
      /* |*/
      ```

### Verify

3. Run `etna_marauders_list` to confirm the mutations are detected.
4. Convert to functional syntax: `etna_marauders_convert` with `to: "functional"` for each file with mutations.
5. Run `etna_cargo_test_base` — all tests must pass on the base version.
6. For each variant, run `etna_cargo_test_variant` — the relevant tests must fail.
7. Mutations that cause compile errors: **discard** (only runtime-observable bugs are committed).
8. Mutations not detected by any test: either add targeted tests and re-run, or remove with an explicit reason.
9. Transitional placeholder removals (e.g., "not injected yet", "blocked by base") are **not allowed** in a completed mutations stage. If testing is blocked, fail/stop the pipeline and fix tests stage conditions first.

### Finalize

10. Convert back to comment syntax: `etna_marauders_convert` with `to: "comment"`.
11. Run `etna_marauders_list` once more to confirm final state.

## Mutation Naming

- **Variant**: `<descriptive_name>_<7-char-commit-hash>_<sequence>`
- Use one shared variant across all injection sites that represent the same logical bug (including multi-file cases)
- **Tags**: descriptive, comma-separated (e.g., `csr,add-node,row-offset`)

## Retention Rules

- **Retain**: variant compiles, base tests pass, at least one test fails on variant
- **Remove**: variant doesn't compile, or no test detects it (after attempting test additions)
- **Every removal must have an explicit reason**
- Removal reasons must be terminal outcomes (`compile error`, `undetected after targeted tests`, `inexpressible`), not temporary execution blockers

## Output Schema

```json
{
  "run_id": "<uuid>",
  "project": "<name>",
  "repo": "<repo url or path>",
  "language": "Rust",
  "total_mutations": 27,
  "mutations": [
    {
      "name": "foo_wrong_operator",
      "file": "src/algo/foo.rs",
      "line": 42,
      "variant": "foo_wrong_operator_abc1234_1",
      "tags": ["algo", "operator", "arithmetic"],
      "bug_type": "wrong-arithmetic-operator",
      "source_commit": "<full_commit_hash>",
      "sites": [
        { "file": "src/algo/foo.rs", "line": 42 },
        { "file": "src/algo/helpers.rs", "line": 10 }
      ],
      "test_mode": "debug",
      "passed": false,
      "detected": true,
      "failing_tests": ["tests::test_foo_correctness"],
      "failure_type": "wrong operator causes incorrect result"
    }
  ]
}
```

## Mutation Count Target

The pipeline targets **20-50 mutations** per project. After finalizing the retained mutations list:

- If the count is **below 20**: flag this in the checkpoint as `below_target: true` and include a `target_note` explaining why (e.g., "project has limited bug-fix history", "most candidates were inexpressible"). The pipeline should attempt to scan more commit history batches before accepting a low count.
- If the count is **above 50**: prioritize the highest-quality mutations and defer the rest.

## Quality Criteria

- All retained mutations compile in both base and variant mode
- All retained mutations are detected (at least one failing test)
- `detected: true` for every entry in the final list
- Mutation syntax is valid marauders comment syntax after finalization
- `total_mutations` matches the array length
- `marauder.toml` exists in the project directory
- `etna_marauders_list` confirms all injected mutations are parseable
- Multi-file/multi-hunk logical bugs are represented by a shared variant across all relevant sites
