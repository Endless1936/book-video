#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readCsv } from "./lib/csv.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
const [episodeName, requestedVersion] = process.argv.slice(2);

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/validate-script.mjs",
  stage: "script_validation",
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

const episodeDir = path.join(ROOT, "episodes", episodeName);
const scriptPath = path.join(episodeDir, "script.csv");
if (!fs.existsSync(scriptPath)) throw new Error(`Missing script.csv: ${scriptPath}`);
const version = resolveScriptVersion(episodeDir, requestedVersion);
const rows = readCsv(scriptPath).rows
  .filter((row) => row.version === version)
  .sort((a, b) => Number(a.order) - Number(b.order));
if (!rows.length) throw new Error(`No script rows found for version ${version}`);

const result = { episode: episodeName, scriptVersion: version, ...validateBodyScript(rows) };
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) {
  throw new WorkflowError(result.errors.join("；"), {
    code: "script_policy_failed",
    details: result,
  });
}
