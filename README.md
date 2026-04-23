# etna-ify

ETNA workload generation for Rust projects with property-based tests.

Given a Rust project, etna-ify mines its entire git history, turns every bug fix into a mutation, and produces a cross-framework benchmarkable workload. Every mutation comes with a framework-neutral property function, a deterministic witness, and adapters for proptest, quickcheck, crabcheck, and hegel.

See `AGENTS.md` for the architecture, `prompts/run.md` for the entry point, and `skills/<stage>/SKILL.md` for per-stage reasoning.

## Pipeline

```
discover  ->  atomize  ->  runner  ->  document  ->  validate
```

- **discover** — full `git log --all`, every fix commit is a candidate.
- **atomize** — one fix → property + 4 framework adapters + witness + mutation + commit.
- **runner** — `src/bin/etna.rs` dispatches `<tool> <property>` programmatically.
- **document** — `BUGS.md` and `TASKS.md` regenerated deterministically via `etna workload doc <dir>` from `etna.toml` (never hand-edited).
- **validate** — base passes, every variant is detected, every framework drives its own crate; manifest/doc consistency delegated to `etna workload check <dir>`.

## Source of truth

- `etna.toml` — the only hand-maintained index. One `[[tasks]]` block per mutation group, with nested `[tasks.source]` / `[tasks.injection]` / `[tasks.bug]` sub-blocks and one-or-more `[[tasks.tasks]]` entries binding a PascalCase `property` to witness `test_fn` names. Top-level `[[dropped]]` blocks record rejected candidates.
- `marauders list` — injected marauders variants.
- `patches/*.patch` — patch-based variants.
- Source `pub fn property_*` and `fn witness_*_case_*` — properties and witnesses.
- Git `etna/<variant>` branches — per-variant committed workload states.

No checkpoint JSONs. `BUGS.md` / `TASKS.md` are derived artefacts — regenerate with `etna workload doc`.

## Enforcement

Every workload under `workloads/Rust/` has a pre-commit hook (`faultloc/scripts/workload_precommit.sh`, installed via `faultloc/scripts/install_workload_hooks.sh`) that pins `etna 0.1.6` and runs `etna workload check .`. Drift in the manifest, missing source symbols, unapplied patches, or hand-edited docs block the commit.

## Workloads

Produced workloads live under `workloads/Rust/`. Each has its own `BUGS.md`, `TASKS.md`, `etna.toml`, `src/bin/etna.rs`, and parallel `etna/<variant>` branches.
