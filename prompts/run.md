---
description: Build an ETNA workload from a Rust project by mining its entire git history
---

# ETNA Workload Generation

Mine the **entire** git history of a Rust project, turn every viable bug fix into a mutation+property+witness triplet with adapters for proptest / quickcheck / crabcheck / hegel, and ship it as an ETNA workload.

## Arguments

- `$1` — project directory (e.g. `workloads/Rust/ordered-float`). Must already be a git working tree.

## Pipeline

Run these five stages in order. Each stage's instructions live in its `SKILL.md`.

1. `skills/discover/SKILL.md` — full history scan, in-memory candidate list.
2. `skills/atomize/SKILL.md` — for **every** candidate: extract fix, write property + 4 framework adapters, inject via marauders or patch, write witness, verify, commit to `etna/<variant>` branch, append a `[[tasks]]` group to `etna.toml`.
3. `skills/runner/SKILL.md` — populate `src/bin/etna.rs` with programmatic dispatch over (tool, property).
4. `skills/document/SKILL.md` — run `etna workload doc <project>` to regenerate `BUGS.md` / `TASKS.md` deterministically from `etna.toml`.
5. `skills/validate/SKILL.md` — run `etna workload check <project>` (manifest + docs), then execute real runs to assert per-variant detection and true framework drive.

## Progress logging

Append one JSON line per progress event to `<project>/progress.jsonl` throughout the run. **This is mandatory.** The file is the durable progress record — stdout is full-buffered when redirected to a log file, and buffered output is lost if the outer wall-clock cap fires and sends SIGTERM.

Contract:
- One JSON object per line; no multi-line objects. Use `>>` append semantics — never rewrite.
- Required fields on every line: `ts` (UTC ISO 8601, e.g. `2026-04-19T22:00:00Z`), `stage` (`discover` | `atomize` | `runner` | `document` | `validate`), `event`.
- Emit a matching `*_start` and `*_done` event bracketing each stage. Between them, emit per-item progress markers (one per candidate commit examined, one per variant committed, one per framework adapter verified, etc.). See each stage's SKILL.md for the exact event catalogue.
- Mirror the same lines to stdout so an attached tail sees them too — but do not rely on stdout alone; the file is the record of truth.

Why this matters:
- **Resumability.** If a run is interrupted, the next agent invocation reads `progress.jsonl` and picks up from the last completed milestone instead of redoing stages. Treat the last line's `stage`/`event` as the resume point.
- **Live observability.** The user (or a monitoring agent) tails `progress.jsonl` to see the run progress in real time.
- **Driver classification.** The overnight driver inspects `progress.jsonl` to decide whether a timed-out run actually completed; a `{"stage":"validate","event":"all_checks_passed"}` line overrides an `rc=124` classification.

Example:
```
{"ts":"2026-04-19T22:00:00Z","stage":"discover","event":"start"}
{"ts":"2026-04-19T22:00:30Z","stage":"discover","event":"done","commits_scanned":1245,"fix_commits":42}
{"ts":"2026-04-19T22:00:31Z","stage":"atomize","event":"start","total_candidates":42}
{"ts":"2026-04-19T22:01:50Z","stage":"atomize","event":"variant_start","name":"foo_abc1234_1","i":1,"of":42}
{"ts":"2026-04-19T22:02:10Z","stage":"atomize","event":"variant_committed","name":"foo_abc1234_1","i":1,"of":42,"injection":"marauders"}
{"ts":"2026-04-19T22:02:20Z","stage":"atomize","event":"variant_skipped","name":"bar_def5678_1","i":2,"of":42,"reason":"no observable invariant"}
{"ts":"2026-04-19T22:55:00Z","stage":"atomize","event":"done","committed":38,"skipped":4}
{"ts":"2026-04-19T22:56:00Z","stage":"runner","event":"framework_built","framework":"hegel"}
{"ts":"2026-04-19T23:05:00Z","stage":"validate","event":"all_checks_passed"}
```

A minimal helper, to be reused from any shell step in the pipeline. Set `PROJECT` to the absolute path of the workload directory (the `$1` argument to this prompt) at the top of the run so the helper can append to the right file:

```sh
PROJECT=/Users/akeles/Programming/projects/PbtBenchmark/faultloc/workloads/Rust/<name>
progress() {
    local stage=$1 event=$2; shift 2
    local extras=""
    for kv in "$@"; do extras="$extras,\"${kv%=*}\":${kv#*=}"; done
    printf '{"ts":"%s","stage":"%s","event":"%s"%s}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$stage" "$event" "$extras" \
        | tee -a "$PROJECT/progress.jsonl"
}
# usage: progress discover start
#        progress discover done commits_scanned=1245 fix_commits=42
#        progress atomize variant_committed 'name="foo_abc1234_1"' i=1 of=42
```

If you prefer Python, emit via `python3 -c 'import json, sys, time; print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "stage": sys.argv[1], "event": sys.argv[2], **dict(kv.split("=",1) for kv in sys.argv[3:])}))' <stage> <event> <k=v>... | tee -a "$PROJECT/progress.jsonl"`. Either is fine — just be consistent within a run.

Values that are strings must be quoted (`name="foo"`); integers and booleans must not be (`i=1`). Mis-quoting breaks JSON — use `python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))'` when in doubt.

## Non-negotiables

- **No checkpoint JSONs.** The source tree, `etna.toml`, and git branches are the only durable state.
- **`etna.toml` is the single source of truth.** `BUGS.md` and `TASKS.md` are regenerated by `etna workload doc`; hand-editing them is prohibited.
- **`etna workload check <dir>` must exit 0.** The pre-commit hook (`faultloc/scripts/workload_precommit.sh`, installed via `faultloc/scripts/install_workload_hooks.sh`) pins `etna 0.1.6` and runs it on every commit. Do not bypass with `--no-verify`.
- **Manifest schema.** The `WorkloadManifest` uses `[[tasks]]` groups with nested `[tasks.source]` / `[tasks.injection]` / `[tasks.bug]` and `[[tasks.tasks]]` sub-blocks.
- **No ranking filter.** Every bug-fix commit becomes a variant unless there is a terminal reason not to (no observable invariant, surface removed, irreducibly nondeterministic).
- **Property function is the portable unit.** `pub fn property_<name>(inputs) -> PropertyResult` lives in source. Every framework adapter calls it. The witness calls it. `etna.rs` calls it.
- **Witness is concrete and deterministic.** `#[test]` named `witness_<name>_case_<tag>`, calling `property_<name>` with frozen inputs. Passes on base, fails on variant.
- **Cross-framework parity.** Each property has adapters for proptest, quickcheck, crabcheck, and hegel. Use the forked quickcheck at `/Users/akeles/Programming/projects/PbtBenchmark/quickcheck` (feature `etna`) and crabcheck at `/Users/akeles/Programming/projects/PbtBenchmark/crabcheck`.
- **Two injection paths.** Marauders comment syntax for localized edits; `patches/<variant>.patch` for everything else. No candidate is dropped for being too distributed.
- **Progress log is required.** Every stage emits start/done markers plus per-item events to `progress.jsonl`. A run that finishes without a `validate.all_checks_passed` event is not a successful run, regardless of what stdout says.

## Project: $1
$@
