---
name: etna-candidates
description: Identify bug-fix commits from a Rust project's git history for ETNA workload generation
---

# Stage: Candidates

## Objective

Scan the project's git history in batches of 50 commits and identify commits that are bug fixes. Produce a ranked candidate list of potential bugs to inject as marauders mutations.

## Execution Steps

1. Use `etna_git_batch` with `offset=0`, `count=50` to fetch the first batch of commits.
   - Default initial scan budget: 150 commits total (offsets 0, 50, 100).
2. For each commit, assess whether it is a bug fix by examining:
   - **Commit message keywords**: "fix", "bug", "patch", "correct", "repair", "panic", "crash", "overflow", "infinite", "regression"
   - **PR/issue references** in the message (e.g., "#123")
   - **Diff content**: small, localized changes in implementation files (not just tests)
3. Score each candidate 1-20 based on bug-fix signal strength.
4. If fewer than 20 candidates are found and more history exists, fetch the next batch with `offset=50`, then `offset=100`, etc.
5. Continue until 20+ candidates or history is exhausted.
6. Write the checkpoint with `etna_checkpoint_write`.
7. If final retained mutations later fall below target, run the `expansion` stage and continue mining until either target is met or `frontportability_stop` is justified by low frontportable yield.

## Bug Fix Signals (ranked by strength)

- **Strong**: message starts with "fix:", "fix!", "bugfix:", contains "panic", "crash"
- **Medium**: message contains "fix", "correct", "repair", references an issue
- **Weak**: small diff to implementation code without explicit fix keywords

## Anti-patterns (reject these)

- Pure refactoring (rename, reformat, reorganize)
- Dependency bumps / CI configuration changes
- Documentation-only changes
- New feature additions without a bug-fix component
- Merge commits

## Output Schema

```json
{
  "run_id": "<uuid from pipeline state>",
  "project": "<project name>",
  "total_commits_scanned": 200,
  "candidate_count": 20,
  "candidates": [
    {
      "hash": "<commit_hash>",
      "date": "<ISO8601>",
      "message": "<commit message>",
      "author": "<name <email>>",
      "files": ["src/algo/foo.rs", "tests/foo.rs"],
      "file_count": 2,
      "hunk_count": 3,
      "score": 15
    }
  ]
}
```

## Quality Criteria

- At least 15 candidates for a mature project with significant history
- No duplicate commits
- Score reflects actual bug-fix likelihood, not just keyword matching
- Every candidate has at least one implementation file (not just test files)
- Candidates are diverse across code regions and bug types
