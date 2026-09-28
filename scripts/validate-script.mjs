#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readCsv } from "./lib/csv.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";
import { beginWorkflowStep, completeWorkflowStep } from "./lib/workflow-state.mjs";

const ROOT = process.cwd();
const [episodeName, requestedVersion] = process.argv.slice(2);
const episodeDir = episodeName ? path.join(ROOT, "episodes", episodeName) : "";

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/validate-script.mjs",
  stage: "script_validation",
  episodeDir,
  workflowStep: "script_validated",
  nextActions: [
    "Inspect the active script rows and the reported line or character limits.",
    "Revise script.csv without changing approved text silently, then rerun validation.",
    "Do not advance to approval or image generation until validation passes.",
  ],
});

if (!episodeName) {
  throw new WorkflowError("Usage: node scripts/validate-script.mjs <episode-name> [script-version]", {
    code: "invalid_arguments",
  });
}

if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
beginWorkflowStep(episodeDir, "script_validated");
const scriptPath = path.join(episodeDir, "script.csv");
if (!fs.existsSync(scriptPath)) throw new Error(`Missing script.csv: ${scriptPath}`);
const version = resolveScriptVersion(episodeDir, requestedVersion);
const rows = readCsv(scriptPath).rows
  .filter((row) => row.version === version)
  .sort((a, b) => Number(a.order) - Number(b.order));
if (!rows.length) throw new Error(`No script rows found for version ${version}`);
const briefPath = path.join(episodeDir, "brief.json");
const brief = fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, "utf8")) : {};
const episodeTitle = String(brief.display_title || brief.displayTitle || brief.title || "").trim();
if (!episodeTitle) throw new Error(`Missing display_title in ${briefPath}`);

const result = { episode: episodeName, scriptVersion: version, ...validateBodyScript(rows, { episodeTitle }) };
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) {
  throw new WorkflowError(result.errors.join("；"), {
    code: "script_policy_failed",
    details: result,
  });
}
completeWorkflowStep(episodeDir, "script_validated");
