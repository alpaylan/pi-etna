---
name: etna-docs
description: Build variant-to-property-test mapping and generate BUGS.md documentation
---

# Stage: Docs

## Objective

Build a per-variant property-detector mapping and generate mutation-focused documentation (BUGS.md and BUGS.html).

## Execution Steps

### Build Property-Detector Mapping

1. Read `mutations` and `tests` checkpoints.
2. For each retained variant, identify the canonical failing property test:
   - Run `etna_cargo_test_variant` with a test filter for property tests (e.g., `property_`)
   - If multiple property tests fail, select the most specific one as canonical
   - If no property test fails, try broader filters or record as needing a new property test
3. For each retained variant, identify a deterministic **trigger-case** property test (prefer names containing `case_`) that reproduces the bug with a hand-crafted input.
4. Record each mapping in `docs.json`.

### Generate BUGS.md (mutation catalog only)

4. Create `BUGS.md` in the project directory with:
   - A header section with project name and mutation count
   - A **Bug Index** table: `| # | Name | Variant | File | Type | Failing Tests | Fix Commit |`
   - A **Detector Mapping** table: `| Variant | Canonical Failing Property Test |`
   - Per-bug detail sections with description and failure profile
   - **Fix Commit source of truth**: use the verified commit from `fixes.json`/`mutations.json` (never infer from variant suffix alone)

### Handoff to Tasks Stage

5. Ensure docs checkpoint has enough mapping metadata (canonical property tests and trigger cases) for the `tasks` stage to build mutation/property/witness triplets.

### Generate BUGS.html

6. Create `BUGS.html` from BUGS.md.

## Output Schema (docs.json)

```json
{
  "run_id": "<uuid>",
  "project": "<name>",
  "repo": "<repo url>",
  "language": "Rust",
  "generated_at": "<ISO8601>",
  "property_detector_filter": "property_",
  "summary": {
    "mutations_final": 27,
    "property_detectors_detected": 27,
    "property_detectors_missing": 0
  },
  "variants": [
    {
      "name": "foo_wrong_operator",
      "variant": "foo_wrong_operator_abc1234_1",
      "canonical_failing_property_test": "property_foo_produces_correct_results",
      "property_trigger_case_test": "property_foo_case_boundary",
      "property_detector_status": "detected",
      "property_filter": "property_",
      "source_commit": "<full_hash>"
    }
  ]
}
```

## BUGS.md Format

```markdown
# <Project> — Injected Bugs

Total mutations: N

## Bug Index

| # | Name | Variant | File | Type | Failing Tests | Fix Commit |
|---|------|---------|------|------|---------------|------------|
| 1 | `name` | `variant` | `file:line` | `type` | N | [`hash`](url) |

## Detector Mapping

| Variant | Canonical Failing Property Test |
|---------|---------------------------------|
| `variant` | `property_test_name` |

## Bug Details

### 1. name
- **Variant**: `variant`
- **File**: `file:line`
...
```

## Property Detector Status Values

Each variant must have one of these statuses:

- **`"detected"`**: A property test reliably catches the mutation in standard proptest runs (256 cases). This is the ideal.
- **`"property_mapped"`**: A property test exists that covers the invariant violated by the bug, but may not trigger reliably in default proptest runs due to edge-case conditions (e.g., full u16-range iterators, specific state combinations). A `canonical_failing_regression_test` MUST also be provided for reliable detection.

Both statuses are accepted by the pipeline gates. Using `"property_mapped"` requires:
1. A `canonical_failing_property_test` field naming the property test
2. A `canonical_failing_regression_test` field naming a reliable detector
3. A `property_note` explaining why the property test may not trigger reliably

## File Path Consistency

File paths in BUGS.md must use the **same full paths** as `mutations.json`. For example, if mutations.json records `"file": "roaring/src/bitmap/store/bitmap_store.rs"` and `"line": 575`, then BUGS.md must show `roaring/src/bitmap/store/bitmap_store.rs:575`, NOT the abbreviated `bitmap_store.rs:575`.

## Quality Criteria

- Every retained mutation has `property_detector_status` of `"detected"` or `"property_mapped"`
- Every retained mutation has a deterministic `property_trigger_case_test` (prefer test names containing `case_`)
- Every `"property_mapped"` variant also has a `canonical_failing_regression_test`
- `summary.property_detectors_missing` is 0
- BUGS.md is consistent with docs.json (same variant names, same canonical tests, same file paths)
- BUGS.md remains mutation-focused (no task triplet details required there)
- docs.json contains canonical property and trigger-case mappings consumed by tasks stage
- Canonical property tests are specific — prefer targeted property tests over broad ones
