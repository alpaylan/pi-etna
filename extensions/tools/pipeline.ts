import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { STAGES, STATE_FILE } from "../constants";
import {
  loadState,
  advanceStart,
  advanceComplete,
  advanceFail,
  advanceSkip,
  gateDetection,
  gatePropertyDetector,
  gateCrossCheckpoint,
  gateSourceCommitConsistency,
  gateTriggerCases,
  gateFrontportabilityStop,
} from "../orchestrator";

export function registerPipelineTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "etna_pipeline_status",
    label: "Pipeline Status",
    description:
      "Report the current state of the ETNA pipeline run, including completed stages, current stage, and available checkpoints.",
    parameters: Type.Object({
      project_dir: Type.String({ description: "Path to project directory" }),
    }),

    async execute(_toolCallId, params) {
      const { project_dir } = params as { project_dir: string };

      const state = await loadState(project_dir);
      const checkpointsDir = path.join(project_dir, "checkpoints");

      const checkpoints = STAGES.map((stage) => {
        const filePath = path.join(checkpointsDir, `${stage}.json`);
        const exists = fs.existsSync(filePath);
        let modified: string | null = null;
        if (exists) {
          modified = fs.statSync(filePath).mtime.toISOString();
        }
        return { stage, exists, path: filePath, modified };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: state || null,
              checkpoints,
              stage_order: STAGES,
            }),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "etna_pipeline_advance",
    label: "Pipeline Advance",
    description:
      "Advance the pipeline state machine. Actions: 'start' begins a new run (or resumes), 'complete' marks current stage done and advances, 'fail' records an error, 'skip' skips a stage.",
    parameters: Type.Object({
      project_dir: Type.String({ description: "Path to project directory" }),
      action: StringEnum(
        ["start", "complete", "fail", "skip"] as const
      ),
      project: Type.Optional(
        Type.String({
          description: "Project name (required for 'start' action)",
        })
      ),
      error: Type.Optional(
        Type.String({ description: "Error message (for 'fail' action)" })
      ),
      force: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Force new run even if state exists",
        })
      ),
    }),

    async execute(_toolCallId, params) {
      const { project_dir, action, project, error, force = false } =
        params as {
          project_dir: string;
          action: "start" | "complete" | "fail" | "skip";
          project?: string;
          error?: string;
          force?: boolean;
        };

      let state;
      switch (action) {
        case "start":
          state = advanceStart(
            project_dir,
            project || path.basename(project_dir),
            force
          );
          break;
        case "complete":
          state = advanceComplete(project_dir);
          break;
        case "fail":
          state = advanceFail(project_dir, error || "Unknown error");
          break;
        case "skip":
          state = advanceSkip(project_dir);
          break;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action,
              state,
            }),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "etna_pipeline_gate_check",
    label: "Pipeline Gate Check",
    description:
      "Run a consistency gate check. 'detection' verifies all mutations are detected. 'property_detector' verifies all have property tests. 'trigger_cases' verifies deterministic property trigger-case tests are mapped. 'frontportability_stop' verifies below-target workloads have a justified frontportability STOP decision. 'source_commit' verifies mutation source commits match extracted fix snippets (additive-only sites are allowed). 'cross_checkpoint' validates all invariants across checkpoint files.",
    parameters: Type.Object({
      project_dir: Type.String({ description: "Path to project directory" }),
      gate: StringEnum(
        ["detection", "property_detector", "trigger_cases", "frontportability_stop", "source_commit", "cross_checkpoint"] as const
      ),
    }),

    async execute(_toolCallId, params) {
      const { project_dir, gate } = params as {
        project_dir: string;
        gate: "detection" | "property_detector" | "trigger_cases" | "frontportability_stop" | "source_commit" | "cross_checkpoint";
      };

      let result;
      switch (gate) {
        case "detection":
          result = gateDetection(project_dir);
          break;
        case "property_detector":
          result = gatePropertyDetector(project_dir);
          break;
        case "trigger_cases":
          result = gateTriggerCases(project_dir);
          break;
        case "frontportability_stop":
          result = gateFrontportabilityStop(project_dir);
          break;
        case "source_commit":
          result = gateSourceCommitConsistency(project_dir);
          break;
        case "cross_checkpoint":
          result = gateCrossCheckpoint(project_dir);
          break;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    },
  });
}
