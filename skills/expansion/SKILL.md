---
name: etna-expansion
description: Expand candidate history scan depth and compute frontportability STOP decision when mutation target cannot be met
---

# Stage: Expansion

## Objective

Increase candidate mining depth beyond the initial scan and determine when to **STOP** history expansion because additional commits are unlikely to yield frontportable bugs.

## When to Run

Run this stage when:
1. `report.summary.mutations_final < state.config.target_mutations[0]`
2. initial candidates scan has not yet reached the stop decision criteria.

## Frontportability Score (FPS)

For each expansion candidate, compute `frontportability_score` in `[0.0, 1.0]`:

- `path_survival` (0/1): target file still exists
- `hunk_anchorability` (0..1): fixed/buggy snippet can be located in current file (exact/fuzzy)
- `symbol_survival` (0..1): key function/type names still present
- `public_api_relevance` (0..1): bug effect observable from public API behavior
- `mutation_expressibility` (0..1): can be injected as local marauders mutation
- `detector_feasibility` (0..1): deterministic public trigger-case test is feasible

Weighted score:

`FPS = 0.15*path_survival + 0.30*hunk_anchorability + 0.15*symbol_survival + 0.20*public_api_relevance + 0.10*mutation_expressibility + 0.10*detector_feasibility`

Candidate is frontportable if `FPS >= 0.60`.

## STOP Policy

Evaluate in rolling windows (recommended window size: 100 commits). Stop expansion when **both** hold for 2 consecutive windows:

1. `frontportable_yield < 0.02` (frontportable candidates / commits in window)
2. `median_fps < 0.45` and `p90_fps < 0.60`

Hard stop if either holds:
- No new frontportable candidates in last 200 commits
- Max expansion budget reached (default: 1000 commits scanned total; configurable)

## Execution Steps

1. Read `candidates.json` and current scan depth.
2. Fetch history in windows with `etna_git_batch`.
3. Score each new candidate with FPS components.
4. Track rolling `window_stats` and stop policy status.
5. Write `expansion.json` with:
   - additional candidates
   - FPS data
   - `frontportability_stop` decision block
6. If stop=false and below mutation target, continue expansion in next iteration.

## Output Schema

```json
{
  "run_id": "<uuid>",
  "project": "<name>",
  "base_commits_scanned": 150,
  "additional_commits_scanned": 350,
  "total_commits_scanned": 500,
  "new_candidate_count": 8,
  "candidate_count_total": 28,
  "new_candidates": [
    {
      "hash": "<commit>",
      "date": "<ISO8601>",
      "message": "<subject>",
      "author": "<name <email>>",
      "files": ["src/foo.rs"],
      "file_count": 1,
      "score": 13,
      "frontportability_score": 0.71,
      "frontportable": true
    }
  ],
  "frontportability_stop": {
    "stop": true,
    "reason": "low frontportable yield across last two windows",
    "thresholds": {
      "min_frontportable_fps": 0.6,
      "yield_threshold": 0.02,
      "median_threshold": 0.45,
      "p90_threshold": 0.6,
      "consecutive_windows": 2,
      "window_size_commits": 100,
      "max_total_scanned": 1000
    },
    "window_stats": [
      {
        "window_start_offset": 400,
        "window_size": 100,
        "candidates_seen": 7,
        "frontportable_count": 0,
        "frontportable_yield": 0.0,
        "median_fps": 0.33,
        "p90_fps": 0.52
      }
    ]
  }
}
```