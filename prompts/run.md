---
description: Start a full ETNA workload generation pipeline for a Rust project
---

# ETNA Workload Generation

Run the full pipeline to generate an ETNA workload from a Rust project's bug-fix history.

## Arguments

- `$1` — project directory path (e.g., `workloads/Rust/petgraph`)
- `$2` — (optional) git repository URL or path

## Instructions

1. **Initialize**: Use `etna_pipeline_advance` with `action: "start"` and the project directory.
2. **Execute each stage in order**:
   - For each stage (`candidates`, `expansion`, `ranked`, `fixes`, `classified`, `tests`, `mutations`, `report`, `docs`, `tasks`, `commit`, `validation`):
     a. Load the corresponding skill by reading `skills/<stage>/SKILL.md`
     b. Follow the skill instructions to produce the stage output
     c. For `fixes`/`mutations`, do **not** assume single-line bugs: support multi-line, multi-hunk, and multi-file logical fixes; keep one shared variant for multi-file sites of the same bug
     d. Write the checkpoint using `etna_checkpoint_write`
     e. Advance the pipeline using `etna_pipeline_advance` with `action: "complete"`
3. **Gate checks**:
   - After `mutations`: run `etna_pipeline_gate_check` with `gate: "detection"`
   - After `docs`: run `gate: "property_detector"` and `gate: "trigger_cases"`
   - After `expansion` (when below target): run `gate: "frontportability_stop"`
   - After `validation`: run `gate: "cross_checkpoint"`
4. **Report**: Show final status with `etna_pipeline_status`.

## Target

- 20–50 injected mutations per project
- Diversity across mutation types (expression, statement, structural)
- All mutations must pass detection and property-detector gates
- Zero undetected mutations in the final workload

## Project: $1
$@
