---
name: etna-tasks
description: Build first-class tasks checkpoint and TASKS.md from mutation/property/witness triplets
---

# Stage: Tasks

## Objective

Produce the workload task catalog as a first-class stage artifact.

Each task is a **mutation/property/witness triplet**:
- `mutation`: injected variant
- `property`: logical property function
- `witness`: deterministic failing input for the mutated build

Property outcome semantics are lowercase tri-state values:
- `passed`
- `failed`
- `discarded`

## Inputs

- `checkpoints/mutations.json`
- `checkpoints/tests.json`
- `checkpoints/docs.json`
- `checkpoints/report.json`
- source property tests (for property function + witness extraction)

## Outputs

1. `checkpoints/tasks.json` (machine-readable)
2. `TASKS.md` (human-readable)

## tasks.json Schema

```json
{
  "run_id": "<uuid>",
  "project": "<name>",
  "repo": "<repo url>",
  "language": "Rust",
  "generated_at": "<ISO8601>",
  "summary": {
    "tasks_total": 16
  },
  "tasks": [
    {
      "task_id": "task_001",
      "variant": "foo_bug_abc123_1",
      "property_function": "property_public_foo_matches_model",
      "property_test": "foo::proptests::test::property_public_foo_case_boundary",
      "witness": "x=[1,2,3], y=[3]",
      "generator": "proptest strategy ...",
      "expected_on_mutation": "failed",
      "expected_on_fixed": "passed"
    }
  ]
}
```

## Rules

- At least one task per retained mutation variant.
- A variant may appear in multiple tasks.
- `expected_on_mutation` and `expected_on_fixed` must be one of: `passed|failed|discarded`.
- Witness must be deterministic and reproducible.
- Property function and generator should be conceptually separated (even if implemented in one proptest function).
- Keep `BUGS.md` mutation-focused; task-level details live in `TASKS.md` and `tasks.json`.
