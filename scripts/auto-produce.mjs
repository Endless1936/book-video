#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseProductionCommand } from "./lib/production-command.mjs";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import {
  createProductionState,
  nextStage,
  readProductionState,
  writeProductionState,
} from "./lib/production-state.mjs";

const ACTIONS = {
  selected: { action: "select_book", expectedOutputs: ["brief.json"] },
  researched: { action: "research_book", expectedOutputs: ["brief.json"] },
  scripted: { action: "write_script", expectedOutputs: ["script.csv"] },
  illustrated: { action: "generate_images", expectedOutputs: [
    "images/result-bridge.png", "images/atmosphere-1.png",
    "images/atmosphere-2.png", "images/atmosphere-3.png",
  ] },
  voiced: { action: "generate_jianying_voiceover", expectedOutputs: ["audio/body-voiceover.mp3"] },
  timed: { action: "run_command", script: "scripts/create-body-timings.mjs", expectedOutputs: ["audio/body-timings.json"] },
  rendered: { action: "run_command", script: "scripts/render-episode-final.mjs", expectedOutputs: ["renders/*.mp4"] },
  verified: { action: "verify_and_report", expectedOutputs: ["production-report.json"] },
};

function episodeDirectory(book) {
  return path.join(process.cwd(), "episodes", slugifyEpisodeName(book));
}

function loadOrCreate(book, mode, batchId = "") {
  const episodeDir = episodeDirectory(book);
  const stateFile = path.join(episodeDir, "production-state.json");
  if (!fs.existsSync(stateFile)) {
    writeProductionState(episodeDir, createProductionState({ book, mode, batchId }));
  }
  return readProductionState(episodeDir);
}

function emitBookAction(book, mode, batchId = "") {
  const state = loadOrCreate(book, mode, batchId);
  const stage = nextStage(state);
  if (stage === null) {
    return { status: "complete", book, stage: null, action: null, inputs: {}, expectedOutputs: [] };
  }
  const definition = ACTIONS[stage];
  const inputs = definition.script
    ? { executable: "node", args: [definition.script, book] }
    : { ...(definition.inputs || {}) };
  return {
    status: "action_required",
    book,
    stage,
    action: definition.action,
    inputs,
    expectedOutputs: definition.expectedOutputs,
  };
}

function emitBatch(books) {
  const batchId = new Date().toISOString().replace(/[:.]/gu, "-");
  const batchDirectory = path.join(process.cwd(), ".book-video-batches");
  fs.mkdirSync(batchDirectory, { recursive: true });
  fs.writeFileSync(path.join(batchDirectory, `${batchId}.json`), `${JSON.stringify({ batchId, books }, null, 2)}\n`);
  for (const book of books) {
    const state = loadOrCreate(book, "batch", batchId);
    if (state.failure || nextStage(state) === null) continue;
    return emitBookAction(book, "batch", batchId);
  }
  return { status: "complete", book: "", stage: null, action: null, inputs: {}, expectedOutputs: [] };
}

try {
  const command = parseProductionCommand(process.argv.slice(2));
  let output;
  if (command.mode === "auto") {
    output = {
      status: "action_required",
      book: "",
      stage: "candidate_selection",
      action: "select_candidate",
      inputs: { theme: command.theme, rerunAs: "book <selected-title>" },
      expectedOutputs: ["data/book-pipeline.csv"],
    };
  } else if (command.mode === "batch") {
    output = emitBatch(command.books);
  } else {
    output = emitBookAction(command.books[0], command.mode);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
