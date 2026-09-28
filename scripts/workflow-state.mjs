#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  completeWorkflowStep,
  reconcileWorkflowState,
  revalidateWorkflowStep,
  workflowNextActions,
  workflowSummary,
} from "./lib/workflow-state.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
const [command = "status", episodeName, legacyStep, ...commandArgs] = process.argv.slice(2);
const episodeDir = episodeName ? path.join(ROOT, "episodes", episodeName) : "";
const legacyStepMap = {
  selected: "book_ready",
  researched: "book_ready",
  book_ready: "book_ready",
  script_validated: "script_validated",
  script_approved: "script_approved",
  illustrated: "illustrated",
  voiced: "voiced",
  timed: "timed",
  rendered: "rendered",
  verified: "verified",
  delivered: "delivered",
};
const commandStep = command === "approve"
  ? "script_approved"
  : command === "deliver"
    ? "delivered"
    : command === "revalidate"
      ? legacyStep
    : command === "record"
      ? legacyStepMap[legacyStep] || ""
      : "";
const validRevalidationArgs = command !== "revalidate"
  || (
    ["illustrated", "voiced"].includes(legacyStep)
    && commandArgs.length === 2
    && commandArgs[0] === "--evidence"
    && typeof commandArgs[1] === "string"
    && commandArgs[1].trim().length > 0
  );

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/workflow-state.mjs",
  stage: "workflow_state",
  episodeDir,
  workflowStep: command === "revalidate" ? "" : commandStep,
  nextActions: [
    "Inspect the episode artifacts and the reported stale or failed step.",
    "Repair the narrowest affected input, then run repair or retry that step.",
    "Do not delete a last valid artifact while repairing workflow state.",
  ],
});

if (
  !episodeName
  || !["status", "next", "repair", "approve", "deliver", "record", "revalidate"].includes(command)
  || (command === "record" && !commandStep)
  || !validRevalidationArgs
) {
  throw new WorkflowError(
    "Usage: node scripts/workflow-state.mjs <status|next|repair|approve|deliver> <episode-name> | revalidate <episode-name> <illustrated|voiced> --evidence \"<step>@<scriptVersion>:<complete step-specific review>\"",
    { code: "invalid_arguments" },
  );
}
if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);

let state;
if (["approve", "deliver"].includes(command)) {
  state = completeWorkflowStep(episodeDir, commandStep, {
    enforceDependencies: true,
  });
} else if (command === "revalidate") {
  state = revalidateWorkflowStep(episodeDir, commandStep, { evidence: commandArgs[1] });
} else if (command === "record") {
  console.warn(`Deprecated: use automatic reconciliation${commandStep === "script_approved" ? " or approve" : commandStep === "delivered" ? " or deliver" : ""}.`);
  if (["script_approved", "delivered"].includes(commandStep)) {
    state = completeWorkflowStep(episodeDir, commandStep, { enforceDependencies: true });
  } else {
    state = reconcileWorkflowState(episodeDir);
    if (state.steps[commandStep].status !== "valid") {
      throw new WorkflowError(`Artifacts for ${commandStep} are not valid`, {
        code: "workflow_artifact_invalid",
      });
    }
  }
} else {
  state = reconcileWorkflowState(episodeDir);
}
if (command === "next") {
  console.log(JSON.stringify({
    episode: state.episode,
    nextActions: workflowNextActions(episodeDir, state),
  }, null, 2));
} else {
  console.log(JSON.stringify(workflowSummary(episodeDir, state), null, 2));
}
