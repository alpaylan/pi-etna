---
name: etna-commit
description: Materialize per-mutation commits on parallel branches and write commit.json
---

# Stage: Commit

## Objective

Create one commit per final mutation variant, on parallel branches sharing a common `base_commit`.

## Inputs

- `checkpoints/mutations.json`
- `checkpoints/report.json`
- `checkpoints/tasks.json`
- mutation-injected source tree

## Outputs

- `checkpoints/commit.json`

## commit.json Schema

```json
{
  "run_id": "<uuid>",
  "project": "<name>",
  "summary": {
    "commits_total": 16
  },
  "commits": [
    {
      "variant": "foo_bug_abc123_1",
      "branch": "etna/foo_bug_abc123_1",
      "base_commit": "<hash>",
      "commit": "<hash>",
      "includes": [
        "source mutation",
        "task entry",
        "BUGS/TASKS/checkpoint delta"
      ]
    }
  ]
}
```

## Rules

- One commit entry per final mutation variant.
- All entries must have the same `base_commit`.
- Branch names must be unique.
- Commit stage is first-class and required before validation.
- If `mutations.total_mutations > 0`, `commit.commits` must be non-empty and cover every retained variant.
- If `mutations.total_mutations == 0`, this is only valid when mutations were fully evaluated and removed for terminal reasons; it is **invalid** when prior stages were blocked (e.g., base tests could not run).
- Do not mark commit stage complete with placeholder notes like "not materialized yet"; either materialize commits or fail the run and return to the blocked stage.
