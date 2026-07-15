import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STAGES, completeStage, createProductionState, failStage,
  nextStage, readProductionState, writeProductionState,
} from "../lib/production-state.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-state-"));
const initial = createProductionState({ book: "我与地坛", mode: "book", batchId: "" });
assert.equal(initial.currentStage, null);
assert.equal(nextStage(initial), "selected");
const selected = completeStage(initial, "selected", "2026-07-16T00:00:00.000Z");
assert.equal(selected.currentStage, "selected");
assert.equal(nextStage(selected), "researched");
assert.throws(() => completeStage(selected, "scripted"), /Expected researched/);
const failed = failStage(selected, "researched", new Error("source unavailable"), "2026-07-16T00:01:00.000Z");
assert.equal(failed.failure.stage, "researched");
assert.equal(failed.failure.attempts, 1);
writeProductionState(dir, failed);
assert.deepEqual(readProductionState(dir), failed);
assert.deepEqual(STAGES, ["selected", "researched", "scripted", "illustrated", "voiced", "timed", "rendered", "verified"]);
fs.rmSync(dir, { recursive: true, force: true });
console.log("production state tests: ok");
