export const STAGES = [
  "candidates",
  "expansion",
  "ranked",
  "fixes",
  "classified",
  "tests",
  "mutations",
  "report",
  "docs",
  "tasks",
  "commit",
  "validation",
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_GUIDANCE: Record<Stage, string> = {
  candidates:
    "Identify likely bug-fix commits and issues from project history. " +
    "Return JSON with scan metadata and candidate list.",
  expansion:
    "Expand candidate mining depth (default target: 500 commits scanned total) when initial scan under-produces reliable final mutations.",
  ranked:
    "Rank candidates by locality, semantic clarity, testability, and diversity. " +
    "Return ordered list with rationale.",
  fixes:
    "Extract precise buggy/fixed before-after code snippets for each selected candidate.",
  classified:
    "Classify each fix by mutation expressibility (expression/statement/structural) and difficulty.",
  tests:
    "Map each candidate to regression and property-based detector tests. " +
    "Include validation outcomes where available.",
  mutations:
    "Define injected marauders variants and retained/removed decisions with reasons.",
  report:
    "Build a consistent report summary and final mutation list derived from checkpoints.",
  docs:
    "Build canonical variant-to-failing-property-test mapping and generate BUGS.md (mutations) + TASKS.md (mutation/property/witness triplets).",
  tasks:
    "Build first-class tasks checkpoint from mutation/property/witness triplets with tri-state property semantics (passed|failed|discarded).",
  commit:
    "Materialize one-per-mutation commit artifacts (parallel branches from a common base) and record commit metadata.",
  validation:
    "Validate cross-checkpoint invariants and produce pass/fail mismatch report.",
};

export const MAX_OUTPUT_SIZE = 100 * 1024; // 100KB truncation limit

export const STATE_FILE = "pi_etna_state.json";
