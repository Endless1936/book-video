#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { validateStageArtifacts } from "./lib/production-artifacts.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { readProductionConfig } from "./lib/production-config.mjs";
import {
  completeStage,
  failStage,
  nextStage,
  readProductionState,
  writeProductionState,
  isTerminalFailure,
} from "./lib/production-state.mjs";

try {
  const [book, stage, outcome, ...messageParts] = process.argv.slice(2);
  if (!book || !stage || !["success", "failure"].includes(outcome)) {
    throw new Error("Usage: record-production-stage.mjs <book> <stage> success|failure [message]");
  }
  const episodeDir = path.join(process.cwd(), "episodes", slugifyEpisodeName(book));
  const state = readProductionState(episodeDir);
  const expected = nextStage(state);
  if (stage !== expected) throw new Error(`Expected ${expected}, received ${stage}`);

  let updated;
  if (outcome === "failure") {
    const message = messageParts.join(" ").trim();
    if (!message) throw new Error("Failure requires a non-empty message");
    updated = failStage(state, stage, new Error(message));
  } else {
    if (stage === "verified") {
      if (state.failure?.stage === "verified") {
        throw new Error("Cannot complete verified: current verified verification attempt failed");
      }
      const reportFile = path.join(episodeDir, "production-report.json");
      const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : {};
      const errors = [];
      if (report.verified !== true) errors.push("production-report.json verified must be true");
      for (const name of ["blankFrames", "placeholderText", "subtitleOverflow"]) {
        if (report.visualChecks?.[name] !== true) errors.push(`production-report.json visualChecks.${name} must be true`);
      }
      if (errors.length) throw new Error(errors.join("; "));
    }
    const activeScriptVersion = stage === "scripted"
      ? resolveScriptVersion(episodeDir)
      : state.activeScriptVersion;
    const errors = validateStageArtifacts(stage, episodeDir, activeScriptVersion, { attemptStartedAt: state.attempts?.voiced?.startedAt || "" });
    if (errors.length) throw new Error(errors.join("; "));
    updated = completeStage(state, stage, new Date().toISOString(), stage === "scripted" ? { activeScriptVersion } : {});
  }
  writeProductionState(episodeDir, updated);
  const limit = readProductionConfig(process.cwd()).stageRetryLimit[stage];
  const terminal = outcome === "failure" && isTerminalFailure(updated, limit);
  process.stdout.write(`${JSON.stringify({ status: terminal ? "terminal_failure" : outcome, book, stage, attempts: updated.failure?.attempts || 0, retryLimit: limit })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
