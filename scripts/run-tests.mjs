#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { discoverTestFiles } from "./lib/script-discovery.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
installWorkflowDiagnostics({
  root: ROOT,
  command: "npm test",
  stage: "repository_tests",
  nextActions: [
    "Inspect the first failing test and its referenced workflow behavior.",
    "Fix only the affected behavior, then rerun the narrow test.",
    "Rerun npm test after the narrow test passes.",
  ],
});

const testFiles = discoverTestFiles(ROOT);
if (!testFiles.length) {
  throw new WorkflowError("No test files were discovered", {
    code: "test_discovery_failed",
  });
}

for (const file of testFiles) {
  const result = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new WorkflowError(`Test failed: ${file}`, {
      code: "test_failed",
      details: { file, status: result.status, signal: result.signal },
    });
  }
}

console.log("all tests: ok");
