---
name: runner
description: Build src/bin/etna.rs as a programmatic, framework-agnostic dispatcher over (tool, property) pairs
---

# Stage: Runner

## Objective

Produce `src/bin/etna.rs` that dispatches `<tool> <property>` programmatically — no shelling out to `cargo test`. Each tool drives its framework's runner directly on the framework-neutral `property_<name>` functions.

## Invocation contract

```
cargo run --release --bin etna -- <tool> <property>
```

Arguments:
- `<tool>`: `etna` | `proptest` | `quickcheck` | `crabcheck` | `hegel`
- `<property>`: a property name (bare, without the `property_` prefix), or `All`

Exit codes:
- `0` — any outcome where the adapter finished normally, including a counterexample being found. Etna treats non-zero as `status: aborted` regardless of what was printed.
- `2` — usage / unknown arguments (the only non-zero exit).

Output (per invocation): exactly one JSON line to stdout:

```
{"status":"passed|failed|aborted","tests":N,"discards":0,"time":"<us>us","counterexample":STRING|null,"error":STRING|null,"tool":"...","property":"..."}
```

Etna's `log_process_output` (`etna2/src/driver.rs:1400`) scans stdout+stderr line-by-line and stores every valid JSON object merged into the experiment context. A counterexample becomes `status: "failed"`; an adapter crash becomes `status: "aborted"`. Human-readable `PASS:/FAIL:` text is ignored.

`tests` is the number of property-function invocations the framework made (generated cases plus shrinks). `time` is a string with explicit units; `<us>us` keeps microsecond resolution (millisecond rounds sub-1 ms frameworks to zero and breaks cross-framework timing comparisons). Time via `Instant::elapsed().as_micros()`.

## Structure

Top of file: imports, `PropertyResult` handling.

```rust
use <crate>::*;
// or re-export from lib.rs if property_* functions are not already pub at the root

fn pr_into_result(p: PropertyResult) -> Result<(), String> {
    match p {
        PropertyResult::Pass | PropertyResult::Discard => Ok(()),
        PropertyResult::Fail(m) => Err(m),
    }
}

#[derive(Default, Clone, Copy)]
struct Metrics { inputs: u64, elapsed_us: u128 }
type Outcome = (Result<(), String>, Metrics);
```

Each framework adapter follows the same shape:
1. Zero its per-framework input counter.
2. Record `let t0 = Instant::now();`.
3. Increment the counter inside the property closure / top-level fn — once per call into `property_<name>`.
4. Read `t0.elapsed().as_micros()` on exit and return `(status, Metrics { inputs, elapsed_us })`.

A helper threads `All` over every property:

```rust
fn run_all<F: FnMut(&str) -> Outcome>(mut f: F) -> Outcome {
    let mut total = Metrics::default();
    let mut final_status = Ok(());
    for prop in ALL_PROPERTIES {
        let (status, m) = f(prop);
        total.inputs += m.inputs;
        total.elapsed_us += m.elapsed_us;
        if status.is_err() && final_status.is_ok() { final_status = status; }
    }
    (final_status, total)
}
```

### Per-property helpers

For each property `<name>` retained in `etna.toml`, the runner needs:

```rust
// 1. Concrete deterministic witness — the canonical case. Used by tool=etna and tool=hegel.
fn check_<name>() -> Result<(), String> {
    pr_into_result(property_<name>(/* frozen inputs from witness_<name>_case_<tag> */))
}

// 2. Called by every framework adapter driver.
// Note: the property function itself is already usable. These helpers exist
// only when the framework needs args adapted (e.g. bounded u8 for quickcheck).
```

### Property name mapping: PascalCase (manifest) vs `property_<snake>` (source)

`etna.toml` stores each property in PascalCase (e.g. `property = "BinhexAlphabetMatchesSpec"`). The Rust function that implements it is `property_<snake_case>` (e.g. `property_binhex_alphabet_matches_spec`). When the CLI dispatches `cargo run --release --bin etna -- <tool> <property>`, the `<property>` argument arrives in PascalCase; the runner's `match property { ... }` arms must match that PascalCase literal and call the snake-cased Rust function.

Concrete example:

- Manifest: `property = "BinhexAlphabetMatchesSpec"`.
- Source: `pub fn property_binhex_alphabet_matches_spec(...) -> PropertyResult`.
- Runner match arm: `"BinhexAlphabetMatchesSpec" => check_binhex_alphabet_matches_spec(),`.

etna-cli uses the same convention via `pascal_to_snake` (`etna2/src/commands/workload/check.rs:307`). Keeping the runner aligned with the helper means `etna workload check` and the runner's dispatch agree on property identity.

### Tool runners

All runners return `Outcome`. Every framework **must** actually drive its own crate — never fake hegel (or any other) by delegating to `run_etna`. A silent delegation produces meaningless numbers (always `inputs=1`, always detects) and misrepresents the whole point of cross-framework comparison. The validate stage greps adapter bodies for the framework crate name (see validate skill).

```rust
use std::time::Instant;
use std::sync::atomic::{AtomicU64, Ordering};

fn run_etna_property(property: &str) -> Outcome {
    if property == "All" { return run_all(run_etna_property); }
    let t0 = Instant::now();
    let status = match property {
        "<Prop1>" => check_<prop1>(),   // "<Prop1>" is a PascalCase literal from etna.toml, not a Rust identifier
        "<Prop2>" => check_<prop2>(),
        _ => return (Err(format!("Unknown property for etna: {property}")), Metrics::default()),
    };
    (status, Metrics { inputs: 1, elapsed_us: t0.elapsed().as_micros() })
}

// Proptest: closures capture freely, so `Arc<AtomicU64>` in-scope works.
// Wrap the library call in `catch_unwind` — if the library-under-test panics
// (common under mutations), we want `TestError::Fail(reason, _)` to carry the
// formatted counterexample, not the raw panic message. Extract that reason
// explicitly instead of `.to_string()`, which drips the "proptest failed..."
// boilerplate into the JSON `error` field.
fn run_proptest_property(property: &str) -> Outcome {
    use proptest::prelude::*;
    use proptest::test_runner::{Config, TestCaseError, TestError, TestRunner};
    use std::panic::AssertUnwindSafe;
    use std::sync::Arc;
    if property == "All" { return run_all(run_proptest_property); }
    let counter = Arc::new(AtomicU64::new(0));
    let t0 = Instant::now();
    let mut runner = TestRunner::new(Config::default());
    let status = match property {
        "<Prop1>" => {
            let c = counter.clone();
            runner.run(&<strategy>, move |args| {
                c.fetch_add(1, Ordering::Relaxed);
                let res = std::panic::catch_unwind(AssertUnwindSafe(|| property_<prop1>(args.clone())));
                match res {
                    Ok(PropertyResult::Pass) | Ok(PropertyResult::Discard) => Ok(()),
                    Ok(PropertyResult::Fail(_)) | Err(_) =>
                        Err(TestCaseError::fail(format!("({:?})", args))),
                }
            }).map_err(|e| match e {
                TestError::Fail(reason, _) => reason.to_string(),
                other => other.to_string(),
            })
        }
        _ => return (Err(format!("Unknown property for proptest: {property}")), Metrics::default()),
    };
    (status, Metrics { inputs: counter.load(Ordering::Relaxed), elapsed_us: t0.elapsed().as_micros() })
}

// Quickcheck (the forked crate) takes a FN POINTER, not a closure:
//   QuickCheck.quicktest(fn(T) -> TestResult)
// Fn pointers cannot capture, so the per-property input counter MUST be a
// `static AtomicU64`. Every property gets its own top-level `qc_<prop>` fn.
static QC_COUNTER: AtomicU64 = AtomicU64::new(0);

fn qc_<prop1>(args: ArgsTy) -> quickcheck::TestResult {
    QC_COUNTER.fetch_add(1, Ordering::Relaxed);
    match property_<prop1>(args) {
        PropertyResult::Pass => quickcheck::TestResult::passed(),
        PropertyResult::Fail(_) => quickcheck::TestResult::failed(),
        PropertyResult::Discard => quickcheck::TestResult::discard(),
    }
}

// The quickcheck fork has an internal 60-second `max_time` default that
// trips `ResultStatus::TimedOut` regardless of the outer etna cap or
// `.tests(...)` count. Override with a very large `.max_time(...)` so the
// only binding constraint is etna's per-run timeout.
fn run_quickcheck_property(property: &str) -> Outcome {
    use quickcheck::{QuickCheck, ResultStatus};
    use std::time::Duration;
    if property == "All" { return run_all(run_quickcheck_property); }
    QC_COUNTER.store(0, Ordering::Relaxed);
    let t0 = Instant::now();
    let result = match property {
        "<Prop1>" => QuickCheck::new()
            .tests(200)
            .max_tests(1000)
            .max_time(Duration::from_secs(86_400))
            .quicktest(qc_<prop1> as fn(ArgsTy) -> quickcheck::TestResult),
        _ => return (Err(format!("Unknown property for quickcheck: {property}")), Metrics::default()),
    };
    let status = match result.status {
        ResultStatus::Finished => Ok(()),
        ResultStatus::Failed { arguments } => Err(format!("({})", arguments.join(" "))),
        ResultStatus::Aborted { err } => Err(format!("aborted: {err:?}")),
        ResultStatus::TimedOut => Err("timed out".into()),
        ResultStatus::GaveUp => Err(format!("gave up after {} tests", result.n_tests_passed)),
    };
    (status, Metrics { inputs: QC_COUNTER.load(Ordering::Relaxed), elapsed_us: t0.elapsed().as_micros() })
}

// Crabcheck has the same fn-pointer constraint as quickcheck:
//   crabcheck::quickcheck::quickcheck(fn(T) -> Option<bool>)
// Use a separate `static CC_COUNTER` — do not share with QC_COUNTER, the two
// frameworks may be invoked back-to-back via `All`.
static CC_COUNTER: AtomicU64 = AtomicU64::new(0);

fn cc_<prop1>(args: ArgsTy) -> Option<bool> {
    CC_COUNTER.fetch_add(1, Ordering::Relaxed);
    match property_<prop1>(args) {
        PropertyResult::Pass => Some(true),
        PropertyResult::Fail(_) => Some(false),
        PropertyResult::Discard => None,
    }
}

// Crabcheck's internal loop is capped at 20,000 cases when using the bare
// `cc::quickcheck(fn)` entry point. For overnight / benchmark runs, use
// `cc::quickcheck_with_config(cc::Config { tests: N }, fn)` to lift the cap.
// Crabcheck wraps the property call in `catch_unwind` itself, so a library
// panic surfaces as `ResultStatus::Failed` — no extra wrapping needed here.
fn run_crabcheck_property(property: &str) -> Outcome {
    use crabcheck::quickcheck as cc;
    if property == "All" { return run_all(run_crabcheck_property); }
    CC_COUNTER.store(0, Ordering::Relaxed);
    let t0 = Instant::now();
    let cfg = cc::Config { tests: 200 }; // bump for benchmark runs
    let result = match property {
        "<Prop1>" => cc::quickcheck_with_config(cfg, cc_<prop1> as fn(ArgsTy) -> Option<bool>),
        _ => return (Err(format!("Unknown property for crabcheck: {property}")), Metrics::default()),
    };
    let status = match result.status {
        cc::ResultStatus::Finished => Ok(()),
        cc::ResultStatus::Failed { arguments } => Err(format!("({})", arguments.join(" "))),
        cc::ResultStatus::TimedOut => Err("timed out".into()),
        cc::ResultStatus::GaveUp => Err(format!("gave up: passed={}, discarded={}", result.passed, result.discarded)),
        cc::ResultStatus::Aborted { error } => Err(format!("aborted: {error}")),
    };
    (status, Metrics { inputs: CC_COUNTER.load(Ordering::Relaxed), elapsed_us: t0.elapsed().as_micros() })
}

// Hegel: real `hegeltest = "0.3.7"` from crates.io. The `Hegel::run()` API
// panics on counterexample, so catch_unwind + downcast the payload.
// Backend note: hegeltest 0.3.7 defaults to a Python/uv subprocess engine,
// adding ~650 ms startup per run. That's a per-invocation overhead, not
// search time — keep in mind when comparing timings.
// Do NOT attempt to pull in the local /Users/akeles/Programming/projects/PbtBenchmark/hegel-rust
// crate (v0.4.5 does not compile as of 2026-04). Stay on crates.io 0.3.7.
// Hegel gotchas:
//   * `data_too_large` health check fires when a generator draws a big
//     collection. Suppress via `.suppress_health_check(HealthCheck::all())`
//     or the benchmark run reports "Health check failure" instead of a
//     counterexample.
//   * A fixed `.seed(...)` replays the same draw every trial. For 10-trial
//     overnight runs, leave seeding to the library default so trials
//     diversify.
//   * The library-under-test may panic. Wrap the property call in
//     `catch_unwind` and, on error, panic with the FORMATTED counterexample
//     so the outer handler surfaces `(a b c)`, not `assertion failed: …`.
//   * Hegel prefixes its own re-panic with `Property test failed: ` — strip
//     that in the error handler.
static HG_COUNTER: AtomicU64 = AtomicU64::new(0);

fn hegel_settings() -> hegel::Settings {
    use hegel::HealthCheck;
    hegel::Settings::new()
        .test_cases(200)
        .suppress_health_check(HealthCheck::all())
}

fn run_hegel_property(property: &str) -> Outcome {
    use hegel::{generators as hgen, Hegel, TestCase};
    use std::panic::AssertUnwindSafe;
    if property == "All" { return run_all(run_hegel_property); }
    HG_COUNTER.store(0, Ordering::Relaxed);
    let t0 = Instant::now();
    let settings = hegel_settings();
    let run_result = std::panic::catch_unwind(AssertUnwindSafe(|| match property {
        "<Prop1>" => {
            Hegel::new(|tc: TestCase| {
                HG_COUNTER.fetch_add(1, Ordering::Relaxed);
                let args: ArgsTy = /* draw inputs via tc.draw(hgen::…) */;
                let cex = format!("({:?})", args);
                let res = std::panic::catch_unwind(AssertUnwindSafe(|| property_<prop1>(args.clone())));
                match res {
                    Ok(PropertyResult::Pass) | Ok(PropertyResult::Discard) => {}
                    Ok(PropertyResult::Fail(_)) | Err(_) => panic!("{cex}"),
                }
            }).settings(settings.clone()).run();
        }
        _ => panic!("__unknown_property:{property}"),
    }));
    let elapsed_us = t0.elapsed().as_micros();
    let inputs = HG_COUNTER.load(Ordering::Relaxed);
    let status = match run_result {
        Ok(()) => Ok(()),
        Err(e) => {
            let msg = if let Some(s) = e.downcast_ref::<String>() { s.clone() }
                      else if let Some(s) = e.downcast_ref::<&str>() { s.to_string() }
                      else { "hegel panicked with non-string payload".to_string() };
            if let Some(rest) = msg.strip_prefix("__unknown_property:") {
                return (Err(format!("Unknown property for hegel: {rest}")), Metrics::default());
            }
            Err(msg.strip_prefix("Property test failed: ").unwrap_or(&msg).to_string())
        }
    };
    (status, Metrics { inputs, elapsed_us })
}
```

### Dispatch + main

```rust
fn run(tool: &str, property: &str) -> Outcome {
    match tool {
        "etna" => run_etna_property(property),
        "proptest" => run_proptest_property(property),
        "quickcheck" => run_quickcheck_property(property),
        "crabcheck" => run_crabcheck_property(property),
        "hegel" => run_hegel_property(property),
        _ => (Err(format!("Unknown tool: {tool}")), Metrics::default()),
    }
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn emit_json(tool: &str, property: &str, status: &str, m: Metrics,
             cex: Option<&str>, err: Option<&str>) {
    let cex = cex.map_or("null".into(), json_str);
    let err = err.map_or("null".into(), json_str);
    println!(
        "{{\"status\":{},\"tests\":{},\"discards\":0,\"time\":{},\"counterexample\":{},\"error\":{},\"tool\":{},\"property\":{}}}",
        json_str(status), m.inputs, json_str(&format!("{}us", m.elapsed_us)),
        cex, err, json_str(tool), json_str(property),
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: {} <tool> <property>", args[0]);
        eprintln!("Tools: etna | proptest | quickcheck | crabcheck | hegel");
        std::process::exit(2);
    }
    let (tool, property) = (args[1].as_str(), args[2].as_str());

    // Silence library-under-test panic noise. Frameworks catch their own
    // panics, but the default hook still prints "thread 'main' panicked ..."
    // to stderr, which is clutter. Also defends against an adapter-level
    // panic escaping — we translate that to status: aborted instead of
    // letting the process exit non-zero.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(tool, property)));
    std::panic::set_hook(prev);

    let (status, m) = match caught {
        Ok(outcome) => outcome,
        Err(p) => {
            let msg = p.downcast_ref::<String>().cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "adapter panic (non-string payload)".into());
            emit_json(tool, property, "aborted", Metrics::default(), None, Some(&msg));
            return;
        }
    };
    match status {
        Ok(()) => emit_json(tool, property, "passed", m, None, None),
        Err(e) => emit_json(tool, property, "failed", m, Some(&e), None),
    }
    // Always exit 0 — etna reads status from JSON, not the exit code.
}
```

## Framework gotchas

Four defaults that silently corrupt overnight / benchmark runs unless each runner handles them up front. Bake these in at generation time — fixing them after the fact is a lot harder than getting them right when the runner is first written.

| Framework  | Symptom when ignored                                   | Fix                                                                                                                   |
|------------|--------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| quickcheck | `status:"failed"` with `error:"timed out"` after ~60s  | `.max_time(Duration::from_secs(86_400))` on the `QuickCheck::new()` chain.                                            |
| hegel      | `Health check failure: data_too_large` in JSON `error` | `.suppress_health_check(HealthCheck::all())` on `Settings`; import `HealthCheck` from `hegel::`.                      |
| proptest   | Counterexample contains a raw panic message            | Wrap the library call in `catch_unwind`; extract `TestError::Fail(reason, _)` and format `reason` as `(args…)`.       |
| hegel      | Counterexample contains `Property test failed: ...`    | Wrap the library call in `catch_unwind` inside the `TestCase` closure; on error, `panic!` with the formatted cex. Strip `Property test failed: ` prefix in the outer handler. |
| crabcheck  | Test count capped at 20,000                            | Use `cc::quickcheck_with_config(cc::Config { tests: N }, fn)` instead of `cc::quickcheck(fn)`.                        |

Crabcheck catches library panics itself (as of the `catch_unwind` fix in `crabcheck/src/quickcheck.rs`) — no extra wrapping needed in the adapter; a panic becomes `ResultStatus::Failed { arguments }`.

The counterexample format is always `(a b c)` across frameworks — do **not** prefix with framework names (`quickcheck counterexample: ...`, `hegel found counterexample: ...`). Downstream (`faultloc`) consumers parse this field as the input, not as framework-specific prose.

## Patch-based variants

Marauders variants activate under `M_<variant>=active` and the runner does not need to know about them. Patch-based variants are different: the runner still does not know about them, because patch activation happens at commit materialization time — the `etna/<variant>` branch has the patch applied, and you test the mutation by building from that branch. The runner itself is identical across base and all variants.

## Progress events

Emit to `<project>/progress.jsonl` per the contract in `prompts/run.md`:

| When                                                                   | Event line                                                                                     |
|------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| Starting runner stage                                                  | `{"stage":"runner","event":"start"}`                                                           |
| `src/bin/etna.rs` compiles for the first time                          | `{"stage":"runner","event":"compiled"}`                                                        |
| An adapter (`proptest`/`quickcheck`/`crabcheck`/`hegel`/`etna`) passes | `{"stage":"runner","event":"framework_passing","framework":"<name>","property":"<name>\|All"}` |
| An adapter fails that was expected to pass on base HEAD                | `{"stage":"runner","event":"framework_failing","framework":"<name>","property":"<name>","error":"<msg>"}` |
| Runner stage complete: all frameworks pass on base HEAD                | `{"stage":"runner","event":"done"}`                                                            |

## Requirements

- `src/bin/etna.rs` compiles and runs on base HEAD.
- `cargo run --release --bin etna -- etna All` passes on base HEAD.
- `cargo run --release --bin etna -- <tool> <prop>` exercises every property adapter at least once for every `<tool>` in `{etna, proptest, quickcheck, crabcheck, hegel}`.
- No subprocesses. The binary links against proptest, quickcheck (the forked `/Users/akeles/Programming/projects/PbtBenchmark/quickcheck` with `etna` feature), crabcheck, and hegeltest directly.
- `property_<name>` functions are **imported**, not reimplemented.
- Every `run_<tool>_property` must actually invoke its framework crate — no stub that delegates to `run_etna_property` or a witness replay. Validate stage 7 grep will flag this.
- Every adapter emits `Metrics { inputs, elapsed_us }`. Timing uses `Instant::elapsed().as_micros()`, never `as_millis()`.
- After any change to `src/bin/etna.rs`, commit on master first, then rebuild every `etna/<variant>` branch from the new master (re-apply patch on a fresh branch off master HEAD). A stale bin on a variant branch produces phantom zero metrics on variant runs.
