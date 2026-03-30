import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { STAGES, STATE_FILE, type Stage } from "./constants";

export interface PipelineState {
  run_id: string;
  project: string;
  project_dir: string;
  stage_order: readonly string[];
  completed_stages: string[];
  current_stage: string | null;
  status: "idle" | "running" | "completed" | "failed";
  started_at: string;
  updated_at: string;
  stage_attempts: Record<
    string,
    { count: number; last_error: string | null; last_attempt_at: string }
  >;
  config: {
    max_attempts: number;
    target_mutations: [number, number];
  };
}

function statePath(projectDir: string): string {
  return path.join(projectDir, "checkpoints", STATE_FILE);
}

export async function loadState(
  projectDir: string
): Promise<PipelineState | null> {
  const p = statePath(projectDir);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw) as PipelineState;
}

export function saveState(state: PipelineState): void {
  const dir = path.join(state.project_dir, "checkpoints");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  state.updated_at = new Date().toISOString();

  const dest = statePath(state.project_dir);
  const tmp = dest + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, dest);
}

export function createState(
  projectDir: string,
  project: string
): PipelineState {
  return {
    run_id: crypto.randomUUID(),
    project,
    project_dir: path.resolve(projectDir),
    stage_order: STAGES,
    completed_stages: [],
    current_stage: null,
    status: "idle",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stage_attempts: {},
    config: {
      max_attempts: 3,
      target_mutations: [20, 50],
    },
  };
}

function nextIncompleteStage(state: PipelineState): string | null {
  for (const stage of state.stage_order) {
    if (!state.completed_stages.includes(stage)) {
      return stage;
    }
  }
  return null;
}

export function advanceStart(
  projectDir: string,
  project: string,
  force: boolean = false
): PipelineState {
  let state = loadStateSync(projectDir);

  if (state && !force) {
    // Resume existing run
    state.status = "running";
    state.current_stage = nextIncompleteStage(state);
  } else {
    // New run
    state = createState(projectDir, project);
    state.status = "running";
    state.current_stage = STAGES[0];
  }

  saveState(state);
  return state;
}

export function advanceComplete(projectDir: string): PipelineState {
  const state = loadStateSync(projectDir);
  if (!state) throw new Error("No pipeline state found");
  if (!state.current_stage) throw new Error("No current stage to complete");

  if (!state.completed_stages.includes(state.current_stage)) {
    state.completed_stages.push(state.current_stage);
  }

  const next = nextIncompleteStage(state);
  if (next) {
    state.current_stage = next;
  } else {
    state.current_stage = null;
    state.status = "completed";
  }

  saveState(state);
  return state;
}

export function advanceFail(
  projectDir: string,
  error: string
): PipelineState {
  const state = loadStateSync(projectDir);
  if (!state) throw new Error("No pipeline state found");
  if (!state.current_stage) throw new Error("No current stage to fail");

  const stage = state.current_stage;
  if (!state.stage_attempts[stage]) {
    state.stage_attempts[stage] = {
      count: 0,
      last_error: null,
      last_attempt_at: "",
    };
  }

  state.stage_attempts[stage].count += 1;
  state.stage_attempts[stage].last_error = error;
  state.stage_attempts[stage].last_attempt_at = new Date().toISOString();

  if (state.stage_attempts[stage].count >= state.config.max_attempts) {
    state.status = "failed";
  }

  saveState(state);
  return state;
}

export function advanceSkip(projectDir: string): PipelineState {
  const state = loadStateSync(projectDir);
  if (!state) throw new Error("No pipeline state found");
  if (!state.current_stage) throw new Error("No current stage to skip");

  if (!state.completed_stages.includes(state.current_stage)) {
    state.completed_stages.push(state.current_stage);
  }

  const next = nextIncompleteStage(state);
  if (next) {
    state.current_stage = next;
  } else {
    state.current_stage = null;
    state.status = "completed";
  }

  saveState(state);
  return state;
}

function loadStateSync(projectDir: string): PipelineState | null {
  const p = statePath(projectDir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as PipelineState;
}

// Gate checks

interface GateResult {
  gate: string;
  passed: boolean;
  mismatches: string[];
}

function readCheckpointSync(projectDir: string, stage: string): any | null {
  const p = path.join(projectDir, "checkpoints", `${stage}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function isGitRepo(dir: string): boolean {
  if (!dir) return false;
  const gitDir = path.join(dir, ".git");
  return fs.existsSync(gitDir);
}

function resolveRepoDir(projectDir: string, projectName: string, candidates: any, fixes: any): string | null {
  const tried = new Set<string>();
  const candidateDirs = [
    fixes?.repo_dir,
    fixes?.repo_path,
    candidates?.repo_dir,
    candidates?.repo_path,
    path.join(projectDir, "source"),
    projectDir,
    path.join("/tmp", projectName),
    path.join("/private/tmp", projectName),
    // common normalization fallback for names like roaring-rs
    path.join("/tmp", projectName.replace(/-rs$/, "")),
    path.join("/private/tmp", projectName.replace(/-rs$/, "")),
  ].filter((v) => typeof v === "string" && v.length > 0) as string[];

  for (const raw of candidateDirs) {
    const dir = path.resolve(raw);
    if (tried.has(dir)) continue;
    tried.add(dir);
    if (isGitRepo(dir)) return dir;
  }

  return null;
}

function normalizeLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function pickSignalLines(snippet: string): string[] {
  return (snippet || "")
    .split("\n")
    .map((l) => normalizeLine(l))
    .filter((l) => l.length >= 3)
    .filter((l) => l !== "{" && l !== "}" && l !== "else {");
}

interface FixSite {
  file: string;
  buggy_code?: string;
  fixed_code?: string;
}

function extractFixSites(fix: any): FixSite[] {
  const sites: FixSite[] = [];

  // New preferred shape: explicit per-site array for multi-hunk / multi-file fixes.
  if (Array.isArray(fix?.sites)) {
    for (const s of fix.sites) {
      if (typeof s?.file !== "string" || s.file.length === 0) continue;
      sites.push({
        file: s.file,
        buggy_code: typeof s?.buggy_code === "string" ? s.buggy_code : undefined,
        fixed_code: typeof s?.fixed_code === "string" ? s.fixed_code : undefined,
      });
    }
  }

  // Backward-compatible shape: single file + snippet pair.
  if (sites.length === 0 && typeof fix?.file === "string" && fix.file.length > 0) {
    sites.push({
      file: fix.file,
      buggy_code: typeof fix?.buggy_code === "string" ? fix.buggy_code : undefined,
      fixed_code: typeof fix?.fixed_code === "string" ? fix.fixed_code : undefined,
    });
  }

  return sites;
}

export function gateDetection(projectDir: string): GateResult {
  const mutations = readCheckpointSync(projectDir, "mutations");
  const mismatches: string[] = [];

  if (!mutations) {
    return { gate: "detection", passed: false, mismatches: ["mutations.json not found"] };
  }

  for (const m of mutations.mutations || []) {
    if (!m.detected) {
      mismatches.push(
        `Mutation "${m.name}" (variant ${m.variant}) is not detected by any test`
      );
    }
  }

  for (const r of mutations.removed || []) {
    const reason = String(r?.reason ?? "");
    if (/not\s+injected\s+yet|blocked\s+by\s+base|not\s+run|pending/i.test(reason)) {
      mismatches.push(
        `Removed variant "${r?.variant ?? "<unknown>"}" has non-terminal reason: "${reason}"`
      );
    }
  }

  return { gate: "detection", passed: mismatches.length === 0, mismatches };
}

// Valid property_detector_status values:
// - "detected": property test reliably catches the mutation
// - "property_mapped": property test exists and covers the invariant, but may
//   not trigger reliably in default proptest runs (e.g., 256 cases insufficient)
const VALID_PROPERTY_STATUSES = new Set(["detected", "property_mapped"]);

export function gatePropertyDetector(projectDir: string): GateResult {
  const docs = readCheckpointSync(projectDir, "docs");
  const mismatches: string[] = [];

  if (!docs) {
    return { gate: "property_detector", passed: false, mismatches: ["docs.json not found"] };
  }

  for (const v of docs.variants || []) {
    if (!VALID_PROPERTY_STATUSES.has(v.property_detector_status)) {
      mismatches.push(
        `Variant "${v.variant}" has invalid property_detector_status "${v.property_detector_status}" (expected: detected or property_mapped)`
      );
    }
    if (!v.canonical_failing_property_test && !v.canonical_failing_regression_test) {
      mismatches.push(
        `Variant "${v.variant}" has no canonical failing test (property or regression)`
      );
    }
  }

  return {
    gate: "property_detector",
    passed: mismatches.length === 0,
    mismatches,
  };
}

export function gateSourceCommitConsistency(projectDir: string): GateResult {
  const fixes = readCheckpointSync(projectDir, "fixes");
  const mutations = readCheckpointSync(projectDir, "mutations");
  const candidates = readCheckpointSync(projectDir, "candidates");
  const state = loadStateSync(projectDir);
  const mismatches: string[] = [];

  if (!fixes) {
    return { gate: "source_commit", passed: false, mismatches: ["fixes.json not found"] };
  }
  if (!mutations) {
    return { gate: "source_commit", passed: false, mismatches: ["mutations.json not found"] };
  }

  const projectName = state?.project || path.basename(projectDir);
  const repoDir = resolveRepoDir(projectDir, projectName, candidates, fixes);
  if (!repoDir) {
    return {
      gate: "source_commit",
      passed: false,
      mismatches: [
        "No git repository found for commit verification (tried checkpoints repo_dir/repo_path, project_dir/source, project_dir, and /tmp fallbacks)",
      ],
    };
  }

  const mutationByVariant = new Map(
    (mutations.mutations || []).map((m: any) => [m.variant, m])
  );
  const removedByVariant = new Map(
    (mutations.removed || []).map((m: any) => [m.variant, m])
  );

  for (const fix of fixes.fixes || []) {
    const variant = fix.variant;
    const retained = mutationByVariant.get(variant);
    const removed = removedByVariant.get(variant);
    const mutation = retained || removed;
    if (!mutation) {
      mismatches.push(
        `Fix variant "${variant}" missing in mutations.json (neither retained nor removed)`
      );
      continue;
    }

    if (fix.commit && mutation.source_commit && fix.commit !== mutation.source_commit) {
      mismatches.push(
        `Variant "${variant}" has commit mismatch: fixes.json=${fix.commit}, mutations.json=${mutation.source_commit}`
      );
    }

    const commit = mutation.source_commit || fix.commit;
    if (!commit) {
      mismatches.push(`Variant "${variant}" has no source commit`);
      continue;
    }

    const sites = extractFixSites(fix);
    if (sites.length === 0) {
      mismatches.push(`Variant "${variant}" has no fix sites (expected file or sites[]) for commit verification`);
      continue;
    }

    for (const [siteIdx, site] of sites.entries()) {
      const file = site.file;
      let diff = "";
      const candidatePaths = [
        file,
        file.startsWith("roaring/") ? file.slice("roaring/".length) : `roaring/${file}`,
      ].filter((p, i, arr) => p && arr.indexOf(p) === i);

      for (const candidatePath of candidatePaths) {
        try {
          const out = execSync(
            `git -C ${JSON.stringify(repoDir)} show --format= --unified=5 ${commit} -- ${JSON.stringify(candidatePath)}`,
            { encoding: "utf-8" }
          );
          if (out && out.trim()) {
            diff = out;
            break;
          }
        } catch {
          // try next candidate path
        }
      }

      if (!diff || !diff.trim()) {
        mismatches.push(
          `Variant "${variant}" commit ${commit.slice(0, 7)} has no diff for file ${file}`
        );
        continue;
      }

      const added = diff
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .map((l) => normalizeLine(l.slice(1)));
      const removed = diff
        .split("\n")
        .filter((l) => l.startsWith("-") && !l.startsWith("---"))
        .map((l) => normalizeLine(l.slice(1)));

      const fixedSignals = pickSignalLines(site.fixed_code || "");
      const buggySignals = pickSignalLines(site.buggy_code || "");

      const hasAddedSignal = fixedSignals.length
        ? fixedSignals.some((line) => added.some((d) => d.includes(line) || line.includes(d)))
        : true;
      const hasRemovedSignal = buggySignals.length
        ? buggySignals.some((line) => removed.some((d) => d.includes(line) || line.includes(d)))
        : true;

      // Source-commit provenance is anchored on the fixed snippet appearing in added lines.
      // Removed-snippet evidence is best-effort only, because many valid fixes are additive-only
      // (new guards/resets/checks) and some commits include unrelated removals in the same file.
      if (!hasAddedSignal) {
        mismatches.push(
          `Variant "${variant}" source commit ${commit.slice(0, 7)} does not contain extracted fixed snippet (site ${siteIdx + 1}/${sites.length}, file ${file}) in added lines`
        );
      }
      const _removedSignalObserved = hasRemovedSignal; // informational only
      void _removedSignalObserved;
    }
  }

  return {
    gate: "source_commit",
    passed: mismatches.length === 0,
    mismatches,
  };
}

export function gateTriggerCases(projectDir: string): GateResult {
  const mutations = readCheckpointSync(projectDir, "mutations");
  const tests = readCheckpointSync(projectDir, "tests");
  const docs = readCheckpointSync(projectDir, "docs");
  const tasks = readCheckpointSync(projectDir, "tasks");
  const report = readCheckpointSync(projectDir, "report");
  const fixes = readCheckpointSync(projectDir, "fixes");
  const candidates = readCheckpointSync(projectDir, "candidates");
  const state = loadStateSync(projectDir);
  const mismatches: string[] = [];

  if (!mutations) {
    return { gate: "trigger_cases", passed: false, mismatches: ["mutations.json not found"] };
  }

  const projectName = state?.project || path.basename(projectDir);
  const resolvedRepoDir = resolveRepoDir(projectDir, projectName, candidates, fixes) || projectDir;
  const repoExecCandidates = [
    path.join("/tmp", projectName),
    path.join("/private/tmp", projectName),
    resolvedRepoDir,
    projectDir,
  ];
  const repoDir =
    repoExecCandidates.find(
      (d) => isGitRepo(d) && fs.existsSync(path.join(d, "Cargo.toml"))
    ) || resolvedRepoDir;

  const variants: string[] = report?.final_mutations
    ? (report.final_mutations || []).map((m: any) => m.variant)
    : (mutations.mutations || []).map((m: any) => m.variant);

  const mutationByVariant = new Map((mutations.mutations || []).map((m: any) => [m.variant, m]));
  const docByVariant = new Map((docs?.variants || []).map((v: any) => [v.variant, v]));
  const taskByVariant = new Map<string, any[]>();
  for (const t of tasks?.tasks || []) {
    if (!t?.variant) continue;
    const arr = taskByVariant.get(t.variant) || [];
    arr.push(t);
    taskByVariant.set(t.variant, arr);
  }

  const commitCheckpoint = readCheckpointSync(projectDir, "commit");
  const commitByVariant = new Map<string, any>();
  for (const c of commitCheckpoint?.commits || []) {
    if (typeof c?.variant === "string") commitByVariant.set(c.variant, c);
  }

  const envBase = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^M_/.test(k))
  ) as NodeJS.ProcessEnv;
  envBase.RUSTUP_TOOLCHAIN = envBase.RUSTUP_TOOLCHAIN || "stable";

  for (const variant of variants) {
    const mutation = mutationByVariant.get(variant) || {};
    const testEntry = tests?.variants?.[variant] || {};
    const docEntry = docByVariant.get(variant) || {};

    const candidateNames = new Set<string>();

    // Prefer first-class task mapping when available.
    for (const t of taskByVariant.get(variant) || []) {
      if (typeof t.property_test === "string") candidateNames.add(t.property_test);
    }

    for (const t of mutation.failing_tests || []) {
      if (typeof t === "string") candidateNames.add(t);
    }
    for (const t of testEntry.failing_tests || []) {
      if (typeof t === "string") candidateNames.add(t);
    }

    if (typeof docEntry.property_trigger_case_test === "string") {
      candidateNames.add(docEntry.property_trigger_case_test);
    }
    for (const t of docEntry.property_trigger_case_tests || []) {
      if (typeof t === "string") candidateNames.add(t);
    }

    const triggerCandidates = [...candidateNames].filter((t) => /case_/i.test(t));
    if (triggerCandidates.length === 0) {
      mismatches.push(
        `Variant "${variant}" has no deterministic property trigger case test (expected a test name containing 'case_')`
      );
      continue;
    }

    // Actively execute one trigger case per variant:
    // 1) base run should pass (fixed behavior)
    // 2) mutated run should fail
    const trigger = triggerCandidates[0];
    const testCmd = `cargo test ${JSON.stringify(trigger)}`;

    try {
      execSync(testCmd, {
        cwd: repoDir,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 180_000,
        env: envBase,
      });
    } catch {
      mismatches.push(
        `Trigger-case base execution failed for ${variant}: ${trigger}`
      );
      continue;
    }

    let mutatedFailed = false;
    const commitEntry = commitByVariant.get(variant);

    if (commitEntry?.materialized && typeof commitEntry.commit === "string") {
      // Preferred mode: execute against materialized per-variant commit.
      const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "etna-trigger-"));
      try {
        execSync(
          `git -C ${JSON.stringify(repoDir)} worktree add --detach ${JSON.stringify(worktreeDir)} ${JSON.stringify(commitEntry.commit)}`,
          { stdio: "pipe", encoding: "utf-8", timeout: 60_000 }
        );

        try {
          execSync(testCmd, {
            cwd: worktreeDir,
            stdio: "pipe",
            encoding: "utf-8",
            timeout: 180_000,
            env: envBase,
          });
          mutatedFailed = false;
        } catch {
          mutatedFailed = true;
        }
      } catch {
        // If worktree setup fails, fall back to env-activation mode.
        const mutEnv = { ...envBase, [`M_${variant}`]: "active" };
        try {
          execSync(testCmd, {
            cwd: repoDir,
            stdio: "pipe",
            encoding: "utf-8",
            timeout: 180_000,
            env: mutEnv,
          });
          mutatedFailed = false;
        } catch {
          mutatedFailed = true;
        }
      } finally {
        try {
          execSync(
            `git -C ${JSON.stringify(repoDir)} worktree remove --force ${JSON.stringify(worktreeDir)}`,
            { stdio: "pipe", encoding: "utf-8", timeout: 60_000 }
          );
        } catch {
          // best-effort cleanup
        }
      }
    } else {
      // Fallback mode: env-activation for functional mutations.
      const mutEnv = { ...envBase, [`M_${variant}`]: "active" };
      try {
        execSync(testCmd, {
          cwd: repoDir,
          stdio: "pipe",
          encoding: "utf-8",
          timeout: 180_000,
          env: mutEnv,
        });
        mutatedFailed = false;
      } catch {
        mutatedFailed = true;
      }
    }

    if (!mutatedFailed) {
      mismatches.push(
        `Trigger-case did not fail under mutation for ${variant}: ${trigger}`
      );
    }
  }

  return {
    gate: "trigger_cases",
    passed: mismatches.length === 0,
    mismatches,
  };
}

export function gateFrontportabilityStop(projectDir: string): GateResult {
  const state = loadStateSync(projectDir);
  const report = readCheckpointSync(projectDir, "report");
  const expansion = readCheckpointSync(projectDir, "expansion");
  const mismatches: string[] = [];

  if (!report) {
    return {
      gate: "frontportability_stop",
      passed: false,
      mismatches: ["report.json not found"],
    };
  }

  const minTarget = state?.config?.target_mutations?.[0] ?? 20;
  const finalCount = report?.summary?.mutations_final ?? 0;

  // If target is met/exceeded, no STOP justification is needed.
  if (finalCount >= minTarget) {
    return {
      gate: "frontportability_stop",
      passed: true,
      mismatches: [],
    };
  }

  const stop = expansion?.frontportability_stop;
  if (!stop) {
    mismatches.push(
      "Below-target workload requires expansion.frontportability_stop analysis"
    );
    return {
      gate: "frontportability_stop",
      passed: false,
      mismatches,
    };
  }

  if (typeof stop.stop !== "boolean") {
    mismatches.push("expansion.frontportability_stop.stop must be boolean");
  }
  if (!stop.reason || typeof stop.reason !== "string") {
    mismatches.push("expansion.frontportability_stop.reason is required");
  }
  if (!stop.thresholds || typeof stop.thresholds !== "object") {
    mismatches.push("expansion.frontportability_stop.thresholds is required");
  }
  if (!Array.isArray(stop.window_stats) || stop.window_stats.length === 0) {
    mismatches.push(
      "expansion.frontportability_stop.window_stats must be a non-empty array"
    );
  }

  const thresholds = stop.thresholds || {};
  const yieldThreshold = Number(thresholds.yield_threshold);
  const medianThreshold = Number(thresholds.median_threshold);
  const p90Threshold = Number(thresholds.p90_threshold);
  const consecutive = Number(thresholds.consecutive_windows ?? 2);

  if (!Number.isFinite(yieldThreshold) || !Number.isFinite(medianThreshold) || !Number.isFinite(p90Threshold)) {
    mismatches.push("frontportability_stop thresholds must include numeric yield/median/p90 thresholds");
  }
  if (!Number.isFinite(consecutive) || consecutive < 1) {
    mismatches.push("frontportability_stop.thresholds.consecutive_windows must be >= 1");
  }

  if (stop.stop === true && Array.isArray(stop.window_stats) && stop.window_stats.length > 0) {
    const k = Math.max(1, Math.floor(Number.isFinite(consecutive) ? consecutive : 2));
    if (stop.window_stats.length < k) {
      mismatches.push(
        `frontportability_stop requires at least ${k} window_stats entries, found ${stop.window_stats.length}`
      );
    } else if (
      Number.isFinite(yieldThreshold) &&
      Number.isFinite(medianThreshold) &&
      Number.isFinite(p90Threshold)
    ) {
      const tail = stop.window_stats.slice(-k);
      for (const [idx, w] of tail.entries()) {
        const y = Number(w.frontportable_yield);
        const m = Number(w.median_fps);
        const p = Number(w.p90_fps);
        if (!(y < yieldThreshold && m < medianThreshold && p < p90Threshold)) {
          mismatches.push(
            `frontportability_stop window ${idx + 1}/${k} does not satisfy stop thresholds: yield=${y}, median=${m}, p90=${p}`
          );
        }
      }
    }
  }

  if (stop.stop !== true) {
    mismatches.push(
      "Below-target workload must continue expansion unless frontportability_stop.stop is true"
    );
  }

  return {
    gate: "frontportability_stop",
    passed: mismatches.length === 0,
    mismatches,
  };
}

export function gateCrossCheckpoint(projectDir: string): GateResult {
  const candidates = readCheckpointSync(projectDir, "candidates");
  const mutations = readCheckpointSync(projectDir, "mutations");
  const report = readCheckpointSync(projectDir, "report");
  const tests = readCheckpointSync(projectDir, "tests");
  const classified = readCheckpointSync(projectDir, "classified");
  const docs = readCheckpointSync(projectDir, "docs");
  const tasks = readCheckpointSync(projectDir, "tasks");
  const commit = readCheckpointSync(projectDir, "commit");
  const validation = readCheckpointSync(projectDir, "validation");
  const state = loadStateSync(projectDir);

  const mismatches: string[] = [];

  if (!report) {
    return {
      gate: "cross_checkpoint",
      passed: false,
      mismatches: ["report.json not found"],
    };
  }

  // Check 0a: validation.json must exist
  if (!validation) {
    mismatches.push(
      "validation.json checkpoint is missing — the validation stage must write its results"
    );
  }

  // Check 0b: marauder.toml must exist
  const marauderToml = path.join(projectDir, "marauder.toml") ;
  const sourceMarauderToml = path.join(projectDir, "source", "marauder.toml");
  if (!fs.existsSync(marauderToml) && !fs.existsSync(sourceMarauderToml)) {
    mismatches.push(
      "marauder.toml not found in project directory or source/ — marauders cannot operate without it"
    );
  }

  // Check 0c: tasks checkpoint must exist (first-class stage)
  if (!tasks) {
    mismatches.push(
      "tasks.json checkpoint is missing — tasks stage must write mutation/property/witness triplets"
    );
  }

  // Check 0d: commit checkpoint must exist (first-class stage)
  if (!commit) {
    mismatches.push(
      "commit.json checkpoint is missing — commit stage must record per-mutation commit metadata"
    );
  }

  // Check 0e: tests stage must be truly executable, not blocked placeholders.
  if (tests?.base) {
    if (tests.base.passed !== true) {
      mismatches.push(
        `tests.base.passed is ${tests.base.passed}; tests stage cannot be considered complete unless base tests pass`
      );
    }
  }

  if (tests?.variants && typeof tests.variants === "object") {
    for (const [variant, result] of Object.entries<any>(tests.variants)) {
      if (result?.status === "blocked_by_base" || result?.failure_type === "not_run") {
        mismatches.push(
          `tests variant ${variant} is marked as blocked/not_run (${result?.status ?? result?.failure_type}); rerun tests stage before completion`
        );
      }
    }
  }

  // Check 0f: mutations removal reasons must be terminal, not transitional blockers.
  if (mutations?.removed && Array.isArray(mutations.removed)) {
    for (const r of mutations.removed) {
      const reason = String(r?.reason ?? "");
      if (/not\s+injected\s+yet|blocked\s+by\s+base|pending|not\s+run/i.test(reason)) {
        mismatches.push(
          `mutations.removed for variant ${r?.variant ?? "<unknown>"} uses transitional reason: "${reason}"`
        );
      }
    }
  }

  // Check 0g: if there are expressible classified mutations, zero retained mutations
  // requires either terminal removals or an explicit frontportability STOP.
  if (classified && mutations && report?.summary) {
    const expressibleCount = (classified.classified || []).filter((c: any) => c?.expressible).length;
    if (expressibleCount > 0 && report.summary.mutations_final === 0 && !mutations?.below_target) {
      mismatches.push(
        "report has zero final mutations despite expressible classified entries and no below_target/frontportability justification"
      );
    }
  }

  // Check 0h: discourage brittle single-line-pair extraction heuristics.
  // Fix extraction should support multi-line / multi-hunk / multi-file snippets.
  const fixes = readCheckpointSync(projectDir, "fixes");
  if (fixes && Array.isArray(fixes.skipped)) {
    for (const s of fixes.skipped) {
      const reason = String(s?.reason ?? "");
      if (/line\s*pair|single\s*line/i.test(reason)) {
        mismatches.push(
          `fixes.skipped for ${s?.hash ?? "<unknown>"} indicates brittle single-line extraction heuristic: "${reason}"`
        );
      }
    }
  }

  // Check 0i: mutation count vs target with frontportability STOP policy.
  // If below target, a validated frontportability_stop decision is required.
  if (state && report.summary) {
    const fp = gateFrontportabilityStop(projectDir);
    if (!fp.passed) {
      for (const m of fp.mismatches) {
        mismatches.push(`frontportability_stop: ${m}`);
      }
    }
  }

  // Check 1: candidates_identified matches candidates array length
  if (candidates && report.summary) {
    if (
      report.summary.candidates_identified !==
      (candidates.candidates || []).length
    ) {
      mismatches.push(
        `report.summary.candidates_identified (${report.summary.candidates_identified}) != candidates.candidates.length (${(candidates.candidates || []).length})`
      );
    }
  }

  // Check 2: mutations_final matches final_mutations array length
  if (report.summary && report.final_mutations) {
    if (
      report.summary.mutations_final !==
      (report.final_mutations || []).length
    ) {
      mismatches.push(
        `report.summary.mutations_final (${report.summary.mutations_final}) != report.final_mutations.length (${(report.final_mutations || []).length})`
      );
    }
  }

  // Check 3: every final mutation exists in mutations.json
  if (mutations && report.final_mutations) {
    const mutationVariants = new Set(
      (mutations.mutations || []).map((m: any) => m.variant)
    );
    for (const fm of report.final_mutations) {
      if (!mutationVariants.has(fm.variant)) {
        mismatches.push(
          `Final mutation "${fm.variant}" not found in mutations.json`
        );
      }
    }
  }

  // Check 4: every failing test in final_mutations exists in tests.json
  if (tests && report.final_mutations) {
    const testVariants = new Set(Object.keys(tests.variants || {}));
    for (const fm of report.final_mutations) {
      if (!testVariants.has(fm.variant)) {
        mismatches.push(
          `Final mutation "${fm.variant}" has no test results in tests.json`
        );
      }
    }
  }

  // Check 5: mutations_undetected == 0
  if (report.summary && report.summary.mutations_undetected !== 0) {
    mismatches.push(
      `report.summary.mutations_undetected is ${report.summary.mutations_undetected}, expected 0`
    );
  }

  // Check 6: every final mutation has a failing regression test
  if (mutations) {
    for (const m of mutations.mutations || []) {
      if (
        !m.failing_tests ||
        (Array.isArray(m.failing_tests) && m.failing_tests.length === 0)
      ) {
        mismatches.push(
          `Mutation "${m.name}" has no failing regression tests`
        );
      }
    }
  }

  // Check 7: every final mutation has a canonical property test in docs.json
  if (docs && report.final_mutations) {
    const docVariants = new Map(
      (docs.variants || []).map((v: any) => [v.variant, v])
    );
    for (const fm of report.final_mutations) {
      const docEntry = docVariants.get(fm.variant);
      if (!docEntry) {
        mismatches.push(
          `Final mutation "${fm.variant}" missing from docs.json`
        );
      } else if (!docEntry.canonical_failing_property_test) {
        mismatches.push(
          `Final mutation "${fm.variant}" has no canonical_failing_property_test in docs.json`
        );
      }
    }
  }

  // Check 8: report.json should include deterministic trigger-case mapping metadata
  if (report.final_mutations) {
    const mappedCount = (report.final_mutations || []).filter(
      (fm: any) => typeof fm.canonical_trigger_case_test === "string" && /case_/i.test(fm.canonical_trigger_case_test)
    ).length;
    if (mappedCount === 0 && (report.final_mutations || []).length > 0) {
      mismatches.push(
        "report.final_mutations has no canonical_trigger_case_test entries (expected at least one deterministic trigger-case mapping containing 'case_')"
      );
    }
  }

  // Check 9: tasks checkpoint includes triplets for final mutations
  if (tasks && report.final_mutations) {
    const taskList = Array.isArray(tasks.tasks) ? tasks.tasks : [];
    if (typeof tasks?.summary?.tasks_total === "number" && tasks.summary.tasks_total !== taskList.length) {
      mismatches.push(
        `tasks.summary.tasks_total (${tasks.summary.tasks_total}) != tasks.tasks.length (${taskList.length})`
      );
    }

    const tasksByVariant = new Map<string, any[]>();
    for (const t of taskList) {
      const variant = typeof t?.variant === "string" ? t.variant : "";
      if (!variant) continue;
      if (!tasksByVariant.has(variant)) tasksByVariant.set(variant, []);
      tasksByVariant.get(variant)!.push(t);
    }

    for (const fm of report.final_mutations) {
      const variantTasks = tasksByVariant.get(fm.variant) || [];
      if (variantTasks.length === 0) {
        mismatches.push(
          `tasks.json missing mutation/property/witness task for variant: ${fm.variant}`
        );
        continue;
      }

      for (const t of variantTasks) {
        if (!t.property_function || typeof t.property_function !== "string") {
          mismatches.push(`tasks.json task for ${fm.variant} missing property_function`);
        }
        if (!t.property_test || typeof t.property_test !== "string") {
          mismatches.push(`tasks.json task for ${fm.variant} missing property_test`);
        }
        if (!t.witness || typeof t.witness !== "string") {
          mismatches.push(`tasks.json task for ${fm.variant} missing witness`);
        }
        const mutRes = t.expected_on_mutation;
        const fixedRes = t.expected_on_fixed;
        const valid = new Set(["passed", "failed", "discarded"]);
        if (!valid.has(mutRes)) {
          mismatches.push(`tasks.json task for ${fm.variant} has invalid expected_on_mutation: ${mutRes}`);
        }
        if (!valid.has(fixedRes)) {
          mismatches.push(`tasks.json task for ${fm.variant} has invalid expected_on_fixed: ${fixedRes}`);
        }

        // Codify: trigger-case tests should point to a generalized property function.
        // If property_test is a deterministic case (contains "_case_"), require property_function
        // to be non-case (no "_case_" in function name).
        if (typeof t.property_test === "string" && /_case_/i.test(t.property_test)) {
          if (typeof t.property_function !== "string" || /_case_/i.test(t.property_function)) {
            mismatches.push(
              `tasks.json task for ${fm.variant} must map case property_test to generalized non-case property_function`
            );
          }
        }
      }
    }
  }

  // Check 10: commit checkpoint includes per-mutation commit metadata
  if (commit && report.final_mutations) {
    const entries = Array.isArray(commit.commits) ? commit.commits : [];

    if (typeof commit?.notes === "string" && /not materialized yet|not materialized because/i.test(commit.notes)) {
      mismatches.push(`commit checkpoint indicates placeholder/incomplete materialization: ${commit.notes}`);
    }
    const byVariant = new Map<string, any>();
    for (const e of entries) {
      if (typeof e?.variant === "string") byVariant.set(e.variant, e);
    }

    const baseSet = new Set<string>();
    for (const fm of report.final_mutations) {
      const e = byVariant.get(fm.variant);
      if (!e) {
        mismatches.push(`commit.json missing commit entry for variant: ${fm.variant}`);
        continue;
      }
      if (!e.commit || typeof e.commit !== "string") {
        mismatches.push(`commit.json entry for ${fm.variant} missing commit hash`);
      }
      if (!e.base_commit || typeof e.base_commit !== "string") {
        mismatches.push(`commit.json entry for ${fm.variant} missing base_commit`);
      } else {
        baseSet.add(e.base_commit);
      }
      if (!e.branch || typeof e.branch !== "string") {
        mismatches.push(`commit.json entry for ${fm.variant} missing branch`);
      }
    }

    if (baseSet.size > 1) {
      mismatches.push(
        `commit.json expected parallel branches from one base_commit, found ${baseSet.size} distinct bases`
      );
    }

    if (typeof commit?.summary?.commits_total === "number" && commit.summary.commits_total !== entries.length) {
      mismatches.push(
        `commit.summary.commits_total (${commit.summary.commits_total}) != commit.commits.length (${entries.length})`
      );
    }
  }

  // Check 11: all checkpoints share the same run_id
  const allCheckpoints = [candidates, mutations, report, tests, docs, tasks, commit].filter(
    Boolean
  );
  const runIds = new Set(allCheckpoints.map((c: any) => c.run_id));
  if (runIds.size > 1) {
    mismatches.push(
      `Inconsistent run_ids across checkpoints: ${[...runIds].join(", ")}`
    );
  }

  // Check 10: file paths in report.final_mutations should use full paths matching mutations.json
  if (mutations && report.final_mutations) {
    for (const fm of report.final_mutations) {
      const mutation = (mutations.mutations || []).find(
        (m: any) => m.variant === fm.variant
      );
      if (mutation) {
        const expectedPrefix = `${mutation.file}:${mutation.line}`;
        if (fm.file && fm.file !== expectedPrefix) {
          mismatches.push(
            `Final mutation "${fm.variant}" file path "${fm.file}" doesn't match mutations.json "${expectedPrefix}"`
          );
        }
      }
    }
  }

  // Check 11: BUGS.md exists and stays mutation-focused (variant coverage)
  const bugsmd = path.join(projectDir, "BUGS.md");
  const sourceBugsmd = path.join(projectDir, "source", "BUGS.md");
  const bugsPath = fs.existsSync(bugsmd)
    ? bugsmd
    : fs.existsSync(sourceBugsmd)
      ? sourceBugsmd
      : null;

  if (!bugsPath) {
    mismatches.push("BUGS.md not found in project directory");
  } else {
    const bugsText = fs.readFileSync(bugsPath, "utf-8");

    if (report.final_mutations) {
      for (const fm of report.final_mutations) {
        if (!bugsText.includes(`\`${fm.variant}\``)) {
          mismatches.push(
            `BUGS.md missing final mutation variant in documentation: ${fm.variant}`
          );
        }
      }
    }
  }

  // Check 12: TASKS.md exists and documents mutation/property/witness triplets
  const tasksmd = path.join(projectDir, "TASKS.md");
  const sourceTasksmd = path.join(projectDir, "source", "TASKS.md");
  const tasksPath = fs.existsSync(tasksmd)
    ? tasksmd
    : fs.existsSync(sourceTasksmd)
      ? sourceTasksmd
      : null;

  if (!tasksPath) {
    mismatches.push("TASKS.md not found in project directory");
  } else {
    const tasksText = fs.readFileSync(tasksPath, "utf-8");

    if (!/##\s+Task Index/i.test(tasksText)) {
      mismatches.push("TASKS.md missing required section: 'Task Index'");
    }

    // Require explicit triplet language so docs stay benchmark-oriented.
    if (!/mutation\/property\/witness triplet/i.test(tasksText)) {
      mismatches.push(
        "TASKS.md should explicitly describe tasks as mutation/property/witness triplets"
      );
    }

    if (report.final_mutations) {
      for (const fm of report.final_mutations) {
        if (!tasksText.includes(`\`${fm.variant}\``)) {
          mismatches.push(
            `TASKS.md missing task mapping for final mutation variant: ${fm.variant}`
          );
        }

        const trigger = fm.canonical_trigger_case_test;
        if (typeof trigger === "string" && trigger.length > 0) {
          if (!tasksText.includes(`\`${trigger}\``)) {
            mismatches.push(
              `TASKS.md missing trigger/witness test reference for ${fm.variant}: ${trigger}`
            );
          }
        }
      }
    }

    // Minimal schema hint for per-task witness column/field
    if (!/Witness/i.test(tasksText)) {
      mismatches.push("TASKS.md should include witness information for each task");
    }
  }

  return {
    gate: "cross_checkpoint",
    passed: mismatches.length === 0,
    mismatches,
  };
}
