import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { STATE_FILE } from "../constants";

function checkpointsDir(projectDir: string): string {
  return path.join(projectDir, "checkpoints");
}

function checkpointPath(projectDir: string, stage: string): string {
  return path.join(checkpointsDir(projectDir), `${stage}.json`);
}

export function registerCheckpointTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "etna_checkpoint_write",
    label: "Checkpoint Write",
    description:
      "Atomically write a JSON checkpoint for a pipeline stage. Creates the checkpoints/ directory if needed. Validates that data includes run_id.",
    parameters: Type.Object({
      project_dir: Type.String({ description: "Path to project directory" }),
      stage: Type.String({
        description:
          "Stage name (candidates, expansion, ranked, fixes, classified, tests, mutations, report, docs, tasks, commit, validation)",
      }),
      data: Type.Any({ description: "JSON data to write as the checkpoint" }),
    }),

    async execute(_toolCallId, params) {
      const { project_dir, stage, data } = params as {
        project_dir: string;
        stage: string;
        data: any;
      };

      if (!data || typeof data !== "object") {
        throw new Error("Checkpoint data must be a JSON object");
      }
      if (!data.run_id) {
        throw new Error("Checkpoint data must include run_id");
      }

      const dir = checkpointsDir(project_dir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const content = JSON.stringify(data, null, 2);
      const dest = checkpointPath(project_dir, stage);

      // Atomic write: temp file + rename
      const tmpFile = path.join(
        dir,
        `.${stage}.${process.pid}.${Date.now()}.tmp`
      );
      fs.writeFileSync(tmpFile, content, "utf-8");
      fs.renameSync(tmpFile, dest);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              stage,
              path: dest,
              bytes: Buffer.byteLength(content, "utf-8"),
            }),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "etna_checkpoint_read",
    label: "Checkpoint Read",
    description: "Read a checkpoint JSON file for a pipeline stage.",
    parameters: Type.Object({
      project_dir: Type.String({ description: "Path to project directory" }),
      stage: Type.String({ description: "Stage name to read" }),
    }),

    async execute(_toolCallId, params) {
      const { project_dir, stage } = params as {
        project_dir: string;
        stage: string;
      };

      const filePath = checkpointPath(project_dir, stage);

      if (!fs.existsSync(filePath)) {
        throw new Error(
          `No checkpoint found for stage "${stage}" at ${filePath}`
        );
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ stage, data }),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "etna_checkpoint_list",
    label: "Checkpoint List",
    description:
      "List all available checkpoint files in a project's checkpoints/ directory.",
    parameters: Type.Object({
      project_dir: Type.String({ description: "Path to project directory" }),
    }),

    async execute(_toolCallId, params) {
      const { project_dir } = params as { project_dir: string };

      const dir = checkpointsDir(project_dir);

      if (!fs.existsSync(dir)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ stages: [], files: [] }),
            },
          ],
        };
      }

      const entries = fs.readdirSync(dir);
      const files: {
        stage: string;
        path: string;
        size_bytes: number;
        modified: string;
      }[] = [];

      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        if (entry === STATE_FILE) continue;
        if (entry.startsWith(".")) continue;

        const filePath = path.join(dir, entry);
        const stat = fs.statSync(filePath);
        const stage = entry.replace(/\.json$/, "");

        files.push({
          stage,
          path: filePath,
          size_bytes: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              stages: files.map((f) => f.stage),
              files,
            }),
          },
        ],
      };
    },
  });
}
