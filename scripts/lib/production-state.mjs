import fs from "node:fs";
import path from "node:path";

export const STAGES = Object.freeze([
  "selected", "researched", "scripted", "illustrated",
  "voiced", "timed", "rendered", "verified",
]);

const STATE_FILE = "production-state.json";

export function createProductionState({ book, mode, batchId = "", now = new Date().toISOString() }) {
  return {
    schemaVersion: 1,
    book,
    mode,
    batchId,
    currentStage: null,
    activeScriptVersion: "",
    completedAt: {},
    failure: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function nextStage(state) {
  if (state.currentStage === null) return STAGES[0];
  const index = STAGES.indexOf(state.currentStage);
  if (index < 0) throw new Error(`Unknown current stage: ${state.currentStage}`);
  return STAGES[index + 1] || null;
}

export function completeStage(state, stage, now = new Date().toISOString(), details = {}) {
  const expected = nextStage(state);
  if (stage !== expected) throw new Error(`Expected ${expected}, received ${stage}`);
  return {
    ...state,
    ...details,
    currentStage: stage,
    completedAt: { ...state.completedAt, [stage]: now },
    failure: null,
    updatedAt: now,
  };
}

export function failStage(state, stage, error, now = new Date().toISOString()) {
  const previousAttempts = state.failure?.stage === stage ? state.failure.attempts : 0;
  return {
    ...state,
    failure: {
      stage,
      message: error.message,
      attempts: previousAttempts + 1,
      failedAt: now,
    },
    updatedAt: now,
  };
}

export function writeProductionState(episodeDir, state) {
  fs.mkdirSync(episodeDir, { recursive: true });
  const destination = path.join(episodeDir, STATE_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

export function readProductionState(episodeDir) {
  return JSON.parse(fs.readFileSync(path.join(episodeDir, STATE_FILE), "utf8"));
}
