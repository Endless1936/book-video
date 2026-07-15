#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseProductionCommand } from "./lib/production-command.mjs";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { buildProductionReport, writeProductionReport } from "./lib/production-report.mjs";
import { readActiveScript } from "./lib/production-artifacts.mjs";
import { readProductionConfig } from "./lib/production-config.mjs";
import { advanceBatch, createBatchState, readBatchState, summarizeBatch, writeBatchState } from "./lib/batch-state.mjs";
import {
  createProductionState,
  failStage,
  nextStage,
  readProductionState,
  writeProductionState,
  isTerminalFailure,
  startStageAttempt,
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

function verifyAndReport(book, episodeDir) {
  const config = readProductionConfig(process.cwd());
  const missing = ["jianyingVoice", "lastBgm"].filter((field) => !config[field]);
  if (missing.length) throw new Error(`Missing local configuration: ${missing.join(", ")}`);

  const rendersDir = path.join(episodeDir, "renders");
  const renders = fs.existsSync(rendersDir)
    ? fs.readdirSync(rendersDir).filter((name) => name.toLowerCase().endsWith(".mp4"))
    : [];
  if (renders.length !== 1) throw new Error("Verification requires exactly one active MP4 under renders/");
  const relativeRender = path.join("renders", renders[0]);
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    path.join(episodeDir, relativeRender),
  ], { encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`ffprobe failed: ${result.error?.message || result.stderr?.trim() || "unknown error"}`);
  }
  let probe;
  try { probe = JSON.parse(result.stdout); } catch { throw new Error("ffprobe returned invalid JSON"); }
  const report = buildProductionReport({
    book,
    voice: config.jianyingVoice,
    bgm: config.lastBgm,
    output: relativeRender,
    probe,
    subtitleCount: readActiveScript(episodeDir, readProductionState(episodeDir).activeScriptVersion).length,
    requiredImageCount: ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"].filter((name) => fs.existsSync(path.join(episodeDir, "images", name))).length,
    enforcedAudio: {
      introVoice: fs.existsSync(path.join(process.cwd(), "assets", "template-audio", "intro-voiceover.mp3")),
      bodyVoice: fs.existsSync(path.join(episodeDir, "audio", "body-voiceover.mp3")),
      bgm: fs.existsSync(path.join(process.cwd(), "assets", "bgm", config.lastBgm)),
      gearSfx: fs.existsSync(path.join(process.cwd(), "assets", "sfx", "gear-scroll.mp3")),
    },
  });
  writeProductionReport(episodeDir, report);
  return {
    status: "action_required",
    book,
    stage: "verified",
    action: "inspect_visual_frames",
    inputs: { render: relativeRender, report: "production-report.json" },
    expectedOutputs: ["production-report.json"],
  };
}

function emitBookAction(book, mode, batchId = "") {
  let state = loadOrCreate(book, mode, batchId);
  const stage = nextStage(state);
  if (stage === null) {
    return { status: "complete", book, stage: null, action: null, inputs: {}, expectedOutputs: [] };
  }
  const config = readProductionConfig(process.cwd());
  const retryLimit = config.stageRetryLimit[stage];
  if (state.failure?.stage === stage && isTerminalFailure(state, retryLimit)) {
    return { status: "terminal_failure", book, stage, action: null, inputs: {}, expectedOutputs: [], attempts: state.failure.attempts, retryLimit, failedStage: stage, resumeRecommendation: `Resolve ${stage} failure before resetting its attempts` };
  }
  if (stage === "voiced") readProductionConfig(process.cwd(), { requireCapability: true });
  const definition = ACTIONS[stage];
  if (stage === "voiced") {
    state = startStageAttempt(state, stage);
    writeProductionState(episodeDirectory(book), state);
  }
  if (definition.action === "verify_and_report") {
    const episodeDir = episodeDirectory(book);
    try {
      const reportFile = path.join(episodeDir, "production-report.json");
      if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
      const action = verifyAndReport(book, episodeDir);
      writeProductionState(episodeDir, {
        ...state,
        failure: null,
        updatedAt: new Date().toISOString(),
      });
      return action;
    } catch (error) {
      writeProductionState(episodeDir, failStage(state, stage, error));
      throw error;
    }
  }
  const inputs = definition.script
    ? { executable: process.execPath, args: [definition.script, book] }
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

function emitBatch(books, resumeBatchId = "") {
  const batchDirectory = path.join(process.cwd(), ".book-video-batches");
  let batch;
  if (resumeBatchId) batch = readBatchState(batchDirectory, resumeBatchId);
  else {
    const batchId = `${Date.now()}-${process.pid}`;
    batch = createBatchState(books, batchId);
    writeBatchState(batchDirectory, batch);
  }
  const config = readProductionConfig(process.cwd());
  while (batch.currentPosition < batch.items.length) {
    const item = batch.items[batch.currentPosition];
    const state = loadOrCreate(item.book, "batch", batch.batchId);
    if (nextStage(state) === null) batch = advanceBatch(batch, { status: "success", failedStage: null, resumeRecommendation: "" });
    else if (isTerminalFailure(state, config.stageRetryLimit[state.failure?.stage] || 1)) batch = advanceBatch(batch, { status: "failure", failedStage: state.failure.stage, resumeRecommendation: `node scripts/auto-produce.mjs resume ${JSON.stringify(item.book)}` });
    else {
      writeBatchState(batchDirectory, batch);
      return { ...emitBookAction(item.book, "batch", batch.batchId), batchId: batch.batchId, continueWith: { executable: process.execPath, args: ["scripts/auto-produce.mjs", "batch", "--resume", batch.batchId] } };
    }
  }
  writeBatchState(batchDirectory, batch);
  return { ...summarizeBatch(batch), book: "", stage: null, action: null, inputs: {}, expectedOutputs: [] };
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
    output = emitBatch(command.books, command.batchId);
  } else {
    output = emitBookAction(command.books[0], command.mode);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
