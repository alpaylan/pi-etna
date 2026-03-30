---
name: etna-fixes
description: Extract precise buggy/fixed code pairs from ranked candidates for mutation injection
---

# Stage: Fixes

## Objective

For each ranked candidate, extract the precise code change that constitutes the bug fix. Do **not** assume fixes are single-line. Support multi-line, multi-hunk, and multi-file fixes by representing all affected fix sites.

## Execution Steps

1. Read the ranked checkpoint with `etna_checkpoint_read` (stage: "ranked").
2. For each ranked candidate:
   a. Use `etna_git_show` to get the full commit diff.
   b. Identify the relevant hunks — isolate only the bug-fix changes, discarding unrelated refactoring or formatting.
   c. If the fix spans multiple hunks and/or files, extract **all** required bug-fix sites under one logical mutation candidate.
   d. If the fix spans multiple commits, use `etna_git_diff_range` to compose them.
   e. Record `buggy_code` / `fixed_code` for each extracted site (multi-line snippets are encouraged when needed for semantic fidelity).
   f. **CRITICAL COMMIT VERIFICATION**: ensure the chosen `commit` actually contains BOTH buggy removals and fixed additions for every extracted site.
      - Verify via `etna_git_show` on that commit + each site file
      - Confirm at least one `buggy_code` signal line appears in removed (`-`) lines and at least one `fixed_code` signal line appears in added (`+`) lines per site
      - If the candidate commit only has follow-up cleanup (or only tests), find the true fixing commit or compose a range with `etna_git_diff_range`
   g. Assign a descriptive `mutation_name` in snake_case.
   h. Generate a `variant` name following the pattern: `<mutation_name>_<short_hash>_1`.
   i. Classify the `mutation_type`: "expression", "statement", or "structural".

## Naming Conventions

- **mutation_name**: descriptive snake_case, e.g., `floyd_warshall_undirected_guard_inverted`
- **variant**: `<mutation_name>_<7-char-hash>_<sequence>`, e.g., `floyd_warshall_undirected_guard_inverted_4c7f18e_1`
- Use the commit hash of the primary fix commit for the hash portion
- For multi-file fixes, keep **one shared variant** across all related sites (do not split into unrelated per-file variants)

## Output Schema

```json
{
  "run_id": "<uuid>",
  "project": "<name>",
  "count": 13,
  "fixes": [
    {
      "commit": "<full_commit_hash>",
      "date": "<ISO8601>",
      "title": "fix: description (#123)",
      "mutation_name": "foo_wrong_operator",
      "variant": "foo_wrong_operator_abc1234_1",
      "mutation_type": "expression",
      "score": 15,
      "file": "src/algo/foo.rs",
      "buggy_code": "a - b",
      "fixed_code": "a + b",
      "hunk_header": "@@ -42,7 +42,7 @@ fn compute",
      "sites": [
        {
          "file": "src/algo/foo.rs",
          "hunk_header": "@@ -42,7 +42,7 @@ fn compute",
          "buggy_code": "a - b",
          "fixed_code": "a + b"
        },
        {
          "file": "src/algo/helpers.rs",
          "hunk_header": "@@ -10,6 +10,7 @@",
          "buggy_code": "if needs_guard { work(); }",
          "fixed_code": "if needs_guard && bound_ok { work(); }"
        }
      ]
    }
  ]
}
```

## Output Schema (continued)

The checkpoint must also include a `skipped` array for any ranked candidates that could not be extracted:

```json
{
  "skipped": [
    {
      "hash": "<commit_hash>",
      "reason": "Fix spans 5 files with interleaved refactoring — cannot isolate the bug-fix hunks"
    }
  ]
}
```

Every ranked candidate must appear in either `fixes` or `skipped` — none may be silently dropped.

## Quality Criteria

- `buggy_code` and `fixed_code` are precise — not the entire file, just the changed region (multi-line snippets are valid and often preferred)
- Do not reject a fix solely because it is not a single-line substitution; multi-hunk/multi-file logical fixes are valid
- Every fix has a clear `mutation_type` classification
- The recorded fix `commit` is the true fixing commit for that snippet (not a nearby refactor/cleanup)
- Variant names are unique and follow the naming convention
- Multi-commit fixes are composed into a single logical fix
- Unrelated changes in the same commit are excluded
- `count + skipped.length` must equal the number of ranked candidates
