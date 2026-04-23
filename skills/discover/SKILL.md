---
name: discover
description: Scan the entire git history of a Rust project and identify every bug-fix commit as a mutation candidate
---

# Stage: Discover

## Objective

Walk the **entire** git history of the target project once and classify every commit as either a bug-fix candidate or not. Do not paginate, do not sample, do not stop early. We want every bug we can possibly mine.

## Execution

1. `git -C <project> log --all --pretty=format:'%H%x00%ai%x00%an <%ae>%x00%s'` — iterate every commit.
2. For each commit, decide: **is this a bug fix?**
3. For every commit that is a fix, inspect the diff (`git show --stat <hash>` first, then `git show <hash>` if the stat looks promising) and carry it forward.

Do not write a checkpoint file. Hold the candidate list in working memory and hand it directly to the `atomize` stage.

## What counts as a fix commit

Accept a commit as a fix when **any** of these hold:

- Subject starts with `fix:` / `fix!:` / `bugfix:` / contains `fix`, `bug`, `patch`, `correct`, `repair`, `panic`, `crash`, `overflow`, `regression`, `unsound`, `incorrect`, `wrong`.
- Subject references an issue/PR whose diff is clearly a fix (e.g. `close #123`, `resolves #456`).
- Subject is neutral but the diff is a small implementation change paired with a new/updated test asserting a previously-wrong behavior.

## What to reject outright

- Merge commits (`^Merge `), unless they introduce the fix themselves.
- Pure formatting / rename / reorganization with no behavior change.
- Dependency bumps, CI, release, changelog-only, doc-only commits.
- New feature commits with no corresponding bug fix inside.
- Revert commits — keep the underlying bug for the original-broken commit instead, if you can find it.

## Per-candidate record

Every candidate must carry forward:

- `hash` (full)
- `date` (ISO 8601)
- `subject`
- `author`
- `files` (implementation files changed — strip pure test/doc files for this summary, but remember them for atomize)
- `hunks` (approximate count — `git show --stat` gives this)
- `reason` (one short line: why this is a fix)

## Guidance

- **Do not rank, do not filter on size.** A 12-file fix still counts. A fix that spans multiple commits (a later follow-up commit fixing the first attempt) still counts — merge them in `atomize`, not here.
- **Do not guess expressibility here.** That is `atomize`'s job.
- **Accept multi-commit fix chains.** If you see `fix foo`, then `fix foo, again`, record both; `atomize` will decide whether to compose or split them.
- **Every commit is considered.** If the history is 5000 commits, you look at 5000 commits. No budget, no offset loop.

## Output

The candidate list is an in-memory array, passed directly to `atomize`. No JSON file. This is intentional — the source tree and git history are the only durable records.

## Progress events

Append to `<project>/progress.jsonl` (see `prompts/run.md` for the contract):

| When                                             | Event line                                                                                          |
|--------------------------------------------------|------------------------------------------------------------------------------------------------------|
| Before the `git log` walk starts                 | `{"stage":"discover","event":"start"}`                                                               |
| Every ~100 commits inspected (optional heartbeat)| `{"stage":"discover","event":"progress","commits_scanned":N,"fix_commits_so_far":K}`                 |
| A commit is classified as a fix candidate        | `{"stage":"discover","event":"candidate","hash":"<short>","subject":"<subject>","files":F,"hunks":H}` |
| Walk complete, handing off to atomize            | `{"stage":"discover","event":"done","commits_scanned":N,"fix_commits":K}`                            |

Always include the `ts` field on every line. On resume, the presence of a `discover.done` line means the walk is already complete — do not redo it; re-derive the candidate list from the in-file `candidate` events (or rewalk; both are cheap).
