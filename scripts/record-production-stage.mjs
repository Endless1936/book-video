#!/usr/bin/env node
import path from "node:path";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { validateStageArtifacts } from "./lib/production-artifacts.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import {
  completeStage,
  failStage,
  nextStage,
  readProductionState,
  writeProductionState,
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
    const activeScriptVersion = stage === "scripted"
      ? resolveScriptVersion(episodeDir)
      : state.activeScriptVersion;
    const errors = validateStageArtifacts(stage, episodeDir, activeScriptVersion);
    if (errors.length) throw new Error(errors.join("; "));
    updated = completeStage(state, stage, new Date().toISOString(), stage === "scripted" ? { activeScriptVersion } : {});
  }
  writeProductionState(episodeDir, updated);
  process.stdout.write(`${JSON.stringify({ status: outcome, book, stage })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
