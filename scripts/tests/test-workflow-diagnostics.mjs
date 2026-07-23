import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  WorkflowError,
  normalizeWorkflowDiagnostic,
} from "../lib/workflow-diagnostics.mjs";

const diagnostic = normalizeWorkflowDiagnostic(
  new WorkflowError("Missing script.csv", {
    code: "missing_script",
    details: { file: "script.csv" },
  }),
  {
    command: "node scripts/validate-script.mjs",
    stage: "script_validation",
    nextActions: ["Create or repair script.csv.", "Rerun validation."],
  },
);
assert.equal(diagnostic.status, "action_required");
assert.equal(diagnostic.recoverable, true);
assert.equal(diagnostic.code, "missing_script");
assert.deepEqual(diagnostic.nextActions, ["Create or repair script.csv.", "Rerun validation."]);

const workflowEntrypoints = [
  "check.mjs",
  "create-body-timings.mjs",
  "create-episode-preview.mjs",
  "download-whisper-model.mjs",
  "init.mjs",
  "process-voiceover.mjs",
  "record-book-candidates.mjs",
  "render-episode-final.mjs",
  "validate-script.mjs",
];
for (const file of workflowEntrypoints) {
  const source = fs.readFileSync(path.resolve("scripts", file), "utf8");
  assert.match(
    source,
    /installWorkflowDiagnostics|reportWorkflowFailure/u,
    `${file} must emit recoverable Agent diagnostics`,
  );
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-diagnostic-"));
try {
  const script = path.resolve("scripts/validate-script.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BOOK_VIDEO_DIAGNOSTIC/u);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "tmp", "last-workflow-diagnostic.json"), "utf8"));
  assert.equal(saved.status, "action_required");
  assert.equal(saved.stage, "script_validation");

  const timingScript = path.resolve("scripts/create-body-timings.mjs");
  const missingOption = spawnSync(process.execPath, [
    timingScript,
    "测试书",
    "--voiceover-not-before",
  ], {
    cwd: directory,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(missingOption.status, 1);
  assert.match(missingOption.stderr, /--voiceover-not-before requires a value/u);

  const diagnosticsUrl = pathToFileURL(path.resolve("scripts/lib/workflow-diagnostics.mjs")).href;
  const parentCode = `
    import { spawnSync } from "node:child_process";
    import { installWorkflowDiagnostics } from ${JSON.stringify(diagnosticsUrl)};
    installWorkflowDiagnostics({ root: process.cwd(), command: "parent-command", stage: "parent" });
    spawnSync(process.execPath, [${JSON.stringify(script)}], { cwd: process.cwd(), stdio: "inherit" });
    throw new Error("parent failed after child");
  `;
  const nested = spawnSync(process.execPath, ["--input-type=module", "-e", parentCode], {
    cwd: directory,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(nested.status, 1);
  const preserved = JSON.parse(fs.readFileSync(path.join(directory, "tmp", "last-workflow-diagnostic.json"), "utf8"));
  assert.equal(preserved.command, "node scripts/validate-script.mjs");
  assert.match(nested.stderr, /parentFailure/u);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("workflow diagnostic tests: ok");
