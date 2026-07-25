#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  WORKFLOW_STEPS,
  completeWorkflowStep,
  reconcileWorkflowState,
  workflowNextActions,
  workflowSummary,
} from "./lib/workflow-state.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
const [command = "status", episodeName, step, ...options] = process.argv.slice(2);
const episodeDir = episodeName ? path.join(ROOT, "episodes", episodeName) : "";

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/workflow-state.mjs",
  stage: "workflow_state",
  episodeDir,
  workflowStep: WORKFLOW_STEPS.includes(step) ? step : "",
  nextActions: [
    "Inspect the episode artifacts and the reported stale or failed step.",
    "Repair the narrowest affected input, then run repair or retry that step.",
    "Do not delete a last valid artifact while repairing workflow state.",
  ],
});

if (!episodeName || !["status", "next", "repair", "record"].includes(command)) {
  throw new WorkflowError(
    "Usage: node scripts/workflow-state.mjs <status|next|repair|record> <episode-name> [step] [--quality <value>]",
    { code: "invalid_arguments" },
  );
}
if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);

if (command === "record") {
  if (!WORKFLOW_STEPS.includes(step)) throw new Error(`Unknown workflow step: ${step}`);
  const qualityIndex = options.indexOf("--quality");
  const qualityOption = options.find((value) => value.startsWith("--quality="));
  const quality = qualityOption
    ? qualityOption.slice("--quality=".length)
    : qualityIndex >= 0 ? options[qualityIndex + 1] || "" : "";
  completeWorkflowStep(episodeDir, step, {
    quality,
    enforceDependencies: true,
  });
}

const state = reconcileWorkflowState(episodeDir);
if (command === "next") {
  console.log(JSON.stringify({
    episode: state.episode,
    nextActions: workflowNextActions(episodeDir, state),
  }, null, 2));
} else {
  console.log(JSON.stringify(workflowSummary(episodeDir), null, 2));
}
