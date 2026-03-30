---
description: Resume an ETNA pipeline from a specific stage
---

# Resume ETNA Pipeline

Resume the workload generation pipeline from where it left off (or from a specific stage) with strict checkpoint/state consistency.

## Arguments

- `$1` — project directory path
- `$2` — (optional) stage to resume from

## Stage Order

`candidates -> expansion -> ranked -> fixes -> classified -> tests -> mutations -> report -> docs -> tasks -> commit -> validation`

## Strict Resume Policy

When resuming, never keep downstream stage artifacts after rewinding to an earlier stage.

If `$2` is provided:
1. Validate `$2` is in the stage order above.
2. Treat `$2` as the new current stage.
3. Remove checkpoints for `$2` and all later stages.
4. Rewrite `checkpoints/pi_etna_state.json` so:
   - `status = "running"`
   - `current_stage = $2`
   - `completed_stages` contains only stages before `$2`
   - keep existing `run_id` unless the user explicitly asks for a new run

If `$2` is not provided:
- Use existing state and continue from `current_stage` (or next incomplete stage).

## Completion Rules (must be enforced while resuming)

- Do not mark a stage complete with placeholder outputs.
- `tests` cannot complete with blocked placeholders (`blocked_by_base`, `not_run`) or `base.passed != true`.
- `mutations` removals must be terminal reasons (not transitional blockers like “not injected yet”).
- `commit` cannot be placeholder-only (“not materialized yet” style notes).

## Instructions

1. Check current status with `etna_pipeline_status` for `$1`.
2. If `$2` is set, apply the strict rewind policy above before executing anything else.
3. For each remaining stage in order:
   a. Read prior checkpoints with `etna_checkpoint_read` for context
   b. Load the corresponding skill (`skills/<stage>/SKILL.md`)
   c. Execute the stage (for `fixes`/`mutations`, do not assume single-line fixes; support multi-line/multi-hunk/multi-file bugs with shared variant names)
   d. Write checkpoint via `etna_checkpoint_write`
   e. Advance via `etna_pipeline_advance` with `action: "complete"`
4. Run gates at required points:
   - after `mutations`: `detection`
   - after `docs`: `property_detector`, `trigger_cases`
   - after `expansion` when below target: `frontportability_stop`
   - after `validation`: `cross_checkpoint`
5. Report final status.

## Project: $1
Starting from: $2
$@