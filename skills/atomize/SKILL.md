---
name: atomize
description: Turn one fix commit into a full mutation+property+witness workload atom, verify it, and commit it
---

# Stage: Atomize

## Objective

For **every** candidate from `discover`, build a complete workload atom: a framework-neutral property function, four framework adapters (proptest / quickcheck / crabcheck / hegel), an injected mutation that recreates the bug, a deterministic witness test, and a per-variant commit. Verify that the base passes and the variant fails before moving on.

One fix commit → one atom. Never drop a candidate for being "too distributed" — if a bug cannot be recreated with marauders comment syntax, use a patch file. A candidate is only dropped for terminal reasons (the bug cannot be reproduced by any property at all, or the code no longer exists and has no behavioral descendant).

## Inputs

- One candidate: `{hash, date, subject, files, hunks, reason}` from `discover`.
- The project's working tree at HEAD.
- `etna.toml` at project root (append-only index; create if missing).

## Per-atom steps

### 1. Understand the bug

1. `git show <hash>` — read the diff end to end.
2. Identify the **invariant** the fix restores. State it to yourself in one sentence: _"After this fix, `f(x)` always has property P"_. If you cannot state an invariant in one sentence, you have not understood the bug yet.
3. Identify the **affected API surface**: which public function(s) now behave correctly that used to be wrong.

If you cannot state an invariant *and* identify a public surface, drop the candidate with reason `no observable public invariant`.

### 2. Extract the fix delta

- If the whole fix is one localized hunk (or multiple hunks in one file that express the same logical change): extract `buggy_code` / `fixed_code` for marauders injection.
- If the fix spans multiple files, or contains interleaved refactoring you cannot cleanly strip: prepare a **patch file** — `git format-patch -1 --stdout <hash>` and save it to `patches/<variant>.patch`, then manually trim unrelated hunks.
- If the fix is additive-only (added guard, added check, added base case): `buggy_code` is the missing code's absence, `fixed_code` is the added block. Marauders supports this.
- If the fix is subtractive-only (removed broken branch): inverse of the above.

Name the mutation: `<descriptive_snake_case>`. Name the variant: `<mutation_name>_<7char_hash>_1`. For composed multi-commit fixes use the newest commit's hash.

### 3. Write the framework-neutral property

The property function lives in the source tree (not under `#[cfg(test)]` unless the whole test layout requires it) with signature:

```rust
pub fn property_<name>(inputs: T) -> PropertyResult
```

Where `PropertyResult` is a three-way result:

```rust
pub enum PropertyResult { Pass, Fail(String), Discard }
```

The function must:
- Take **concrete, owned** inputs — no generators, no framework types.
- Return `Pass` when the invariant holds, `Fail(message)` when violated, `Discard` when the input is outside the intended domain (e.g. out-of-range index).
- Be **totally deterministic**: no RNG, no clock, no filesystem, no threads.

Prefer deriving the property from an **existing** proptest/quickcheck test body in the project; lift the invariant out of the macro and into a pure function, then have the existing tests call the new function. Only write a fresh property if none of the existing PBTs cover the invariant.

Reuse an existing `property_<name>` across multiple variants when more than one bug violates the same invariant. Do not create two properties that differ only in name.

### 4. Write framework adapters

Each adapter wraps `property_<name>` — no re-implementation of the invariant inside the adapter. Place them next to the property, module-gated per framework as needed:

```rust
proptest! {
    #[test]
    fn proptest_<name>(args in <strategy>) {
        match property_<name>(args) {
            PropertyResult::Pass | PropertyResult::Discard => {}
            PropertyResult::Fail(m) => prop_assert!(false, "{m}"),
        }
    }
}

#[quickcheck]
fn quickcheck_<name>(args: ArgsTy) -> quickcheck::TestResult {
    match property_<name>(args) {
        PropertyResult::Pass => TestResult::passed(),
        PropertyResult::Discard => TestResult::discard(),
        PropertyResult::Fail(_) => TestResult::failed(),
    }
}

// crabcheck and hegel adapters follow the same pattern — see skills/runner.
```

### 5. Inject the bug

- **Marauders path**: edit the source with the comment syntax:
  ```rust
  /*| <mutation_name> [<tags>] */
  <fixed_code>
  /*|| <variant_name> */
  /*|
  <buggy_code>
  */
  /* |*/
  ```
  Then run `marauders list --path <project>` to confirm the variant is parsed.

- **Patch path**: stash the full corrective patch in `patches/<variant>.patch`. The patch's direction is **fixed → buggy** (applying the patch installs the bug). The runner activates patch-based variants via an env var or a generated file; we establish the convention in the `runner` stage. For the commit, apply the patch to a fresh worktree and commit the result on the `etna/<variant>` branch.

### 6. Write the witness test

The witness is a concrete `#[test]` — not parameterized, not under `proptest!`/`#[quickcheck]`. Its job is to be the minimal reproducible detector.

**Required contract:**
- Name: `witness_<name>_case_<tag>` (the `case_` token is required; documentation and gates look for it).
- Body: calls **`property_<name>`** directly with frozen inputs. Does **not** call the buggy API surface directly.
- Assertion: asserts the `Pass` variant. The fixed code makes this pass; the mutation makes `property_<name>` return `Fail(..)` or panic, failing the assertion.
- No RNG, no clock, no `std::env`, no `thread::sleep`, no network, no filesystem beyond embedded constants.
- Minimal: smallest input that hits the mutated path. If you need more than ~10 lines of setup, the input is not minimized.
- Base behavior: **passes**. If the witness fails on the base HEAD, the inputs are wrong — fix them, don't paper over.
- Variant behavior: **fails**. If it passes under `M_<variant>=active`, the witness doesn't actually touch the mutated path — fix the inputs.

Write **at least one** witness per variant. If the bug has multiple interesting triggers, write multiple witnesses; each gets a distinct `case_<tag>` suffix.

### 7. Verify

Three runs, all three must pass their expected outcome. Cache results per-variant; re-running is fine.

1. `cargo test witness_<name>_case_` on base HEAD — **must pass**.
2. `cargo test proptest_<name> quickcheck_<name>` on base HEAD — **must pass** (or the property is too strict / the generators wrong).
3. Convert marauders to functional syntax (`marauders convert --path <file> --to functional`), then `M_<variant>=active cargo test witness_<name>_case_` — **must fail** on the witness test.

If step 3 fails to fail, **fix it here**. Either the witness inputs don't reach the mutated code, or the property is too lenient. Do not move on with an undetected variant.

After verification, convert marauders back to comment syntax (`--to comment`).

### 8. Record in `etna.toml`

Append one `[[tasks]]` group (with its nested sub-blocks) to `etna.toml`. Top-level `name`, `description`, `language`, `crate`, and `base_commit` are set once the first time atomize runs on a workload; subsequent candidates only append new `[[tasks]]` or `[[dropped]]` blocks.

Canonical shape:

```toml
[[tasks]]
mutations = ["<variant_name>"]

[tasks.source]
repo = "https://github.com/<owner>/<repo>"
commits = ["<full_hash>"]
commit_subjects = ["<subject from `git show -s --format=%s <hash>`>"]
prs = [<n>]        # or issues = [<n>], or origin = "fuzzing" / "internal report"
summary = "<1-3 sentence excerpt of the fix rationale, usually lifted from the PR body>"

[tasks.injection]
kind = "marauders"  # or "patch"
files = ["src/foo.rs"]
locations = [{ file = "src/foo.rs", line = 42, symbol = "Foo::bar" }]
patch = "patches/<variant>.patch"   # only when kind = "patch"

[tasks.bug]
short_name = "<descriptive_snake_case>"   # human name, no hash suffix
invariant = "<one paragraph stating the invariant the fix restores>"
how_triggered = "<one paragraph describing how the mutation violates the invariant>"

[[tasks.tasks]]
property = "<PascalCaseName>"   # PascalCase in manifest; Rust fn is property_<snake_case>
witnesses = [
  { test_fn = "witness_<snake>_case_<tag>", note = "<optional per-witness note>" },
]
```

Rules and gotchas to honor when filling this in:

- **Single source of truth.** `etna.toml` is the only hand-maintained index. `BUGS.md` / `TASKS.md` are regenerated by `etna workload doc` — never edit them directly.
- **PascalCase ↔ snake_case.** `property = "BinhexAlphabetMatchesSpec"` maps to `pub fn property_binhex_alphabet_matches_spec`. etna-cli uses `pascal_to_snake` (`etna2/src/commands/workload/check.rs:307`) to verify the mapping; the runner's match arms must use the same PascalCase literal (see `skills/runner/SKILL.md`).
- **Variant-name regex.** `^[a-z][a-z0-9_]*_[0-9a-f]{7,40}_[0-9]+$`. The hash portion is 7-40 hex chars (v2 relaxation); prefer 7 unless a collision within the workload forces a longer prefix.
- **Cross-framework coverage is implicit.** Every task is driven by all four frameworks via `src/bin/etna.rs`, and `TASKS.md` emits one row per (variant, framework) automatically.
- **`mutations` is a `Vec<String>`.** A single `[[tasks]]` group may bundle multiple variants that share the same property/witness set; the default and common case is a single-element vec.
- **Required source fields.** `repo`, `commits`, and `summary` are required under `[tasks.source]`. `commit_subjects`, `prs`, `issues`, `discussion`, and `origin` are optional (see `SourceContext` in `etna2/src/workload.rs:421`). If the bug came from a fuzzer or private report rather than a PR, set `origin = "fuzzing"` and leave `prs` / `issues` empty.
- **`[tasks.injection].locations`.** Each location is `{ file, line?, symbol? }`. Line numbers may drift across refactors; keep `symbol` set so readers can find the site even after code movement.
- **Dropped candidates.** Terminal-reason skips go in **top-level `[[dropped]]` blocks**, not TOML comments (see the "Dropping a candidate" section below).

Real-world references for end-to-end shape: `workloads/Rust/half/etna.toml` (marauders + patch mix, 3 variants), `workloads/Rust/rust-base64/etna.toml` (uses `[[dropped]]`), `workloads/Rust/arrayvec/etna.toml` (multiple dropped candidates).

After writing the block, run `etna workload check <project>`. It catches variant-name regex violations, manifest ↔ `marauders list` drift, missing witness/property functions, patch-apply failure, doc drift, and variant-branch ancestry drift in one pass. This is what the pre-commit hook runs on step 9 — cheaper to fix now than on commit.

### 9. Commit

One commit per variant on a parallel branch:

```sh
git -C <project> switch -c etna/<variant_name> <base_commit>
# stage: source mutation edits / patches/<variant>.patch / property+adapters+witness / etna.toml delta
git -C <project> commit -m "etna: inject <variant_name>"
git -C <project> switch -       # back to where we were
```

All variants share the **same `<base_commit>`** — the HEAD of the project at the start of the atomize run. Record it once and reuse.

The workload's pre-commit hook runs `etna workload check .` on every commit. If it fails, the just-recorded `[[tasks]]` block is inconsistent with the source tree (bad regex, missing witness, unapplied patch, doc drift, etc.). Fix it in place — do not `--no-verify`.

## Dropping a candidate

Terminal reasons only. Record the dropped candidate as a top-level `[[dropped]]` block in `etna.toml` (not a TOML comment, not a separate file):

```toml
[[dropped]]
commit = "<short_hash>"
subject = "<commit subject>"   # optional but usually worth keeping
reason = "<one-line terminal reason>"
```

Terminal reason examples:

- `no observable public invariant` — the fix changes internal state with no behavioral consequence exposed by public API.
- `surface removed` — the affected API no longer exists in the current tree and has no successor.
- `probabilistic bug` — the bug depends on real-world nondeterminism (RNG, timing, OS) that cannot be frozen for a witness.

If the drop reason starts with "not yet", "later", "TODO", or "blocked", it is not terminal — keep working until it is.

## Idempotence

Running `atomize` on the same candidate twice must be safe. Before injecting, check `marauders list` (or `etna.toml`'s `[[tasks]].mutations`) for the variant name; if present, skip. Before writing a property, check manifest's `[[tasks.tasks]].property` entries for the PascalCase name *and* grep `pub fn property_<snake>` in source; if it exists and signatures match, reuse it.

## Progress events

Emit to `<project>/progress.jsonl` per the contract in `prompts/run.md`:

| When                                         | Event line                                                                                                               |
|----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| Starting atomize stage                       | `{"stage":"atomize","event":"start","total_candidates":N}`                                                               |
| Starting work on candidate `i`               | `{"stage":"atomize","event":"variant_start","name":"<variant>","hash":"<short>","i":I,"of":N}`                           |
| Witness verified: base passes, variant fails | `{"stage":"atomize","event":"variant_detected","name":"<variant>","i":I,"of":N,"injection":"marauders"\|"patch"}`        |
| Variant committed on its etna/ branch        | `{"stage":"atomize","event":"variant_committed","name":"<variant>","i":I,"of":N,"branch":"etna/<variant>"}`              |
| Candidate dropped for a terminal reason      | `{"stage":"atomize","event":"variant_skipped","name":"<variant>","i":I,"of":N,"reason":"<reason>"}`                      |
| All candidates processed                     | `{"stage":"atomize","event":"done","committed":C,"skipped":S}`                                                           |

`variant_detected` without a following `variant_committed` means the injection worked but the commit step failed — resume should re-run from commit.

**Resume logic:** on a second invocation, scan `progress.jsonl` for the most recent `variant_start` without a matching `variant_committed`/`variant_skipped` — that is the candidate to resume from. All earlier `variant_committed` entries are already done (verify via `git branch --list etna/<name>` + `etna.toml` grep before skipping).
