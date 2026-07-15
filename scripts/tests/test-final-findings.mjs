import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBatchState, advanceBatch, summarizeBatch, writeBatchState, readBatchState } from "../lib/batch-state.mjs";
import { DEFAULT_CONFIG, validateConfig } from "../lib/production-config.mjs";
import { validateRenderedArtifact, validateStageArtifacts, validateVoicedArtifact } from "../lib/production-artifacts.mjs";
import { buildProductionReport } from "../lib/production-report.mjs";
import { createProductionState, failStage, isTerminalFailure, startStageAttempt } from "../lib/production-state.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-final-findings-"));
try {
  const created = createBatchState(["甲", "乙"], "batch-1", "2026-01-01T00:00:00.000Z");
  assert.equal(created.currentPosition, 0);
  assert.deepEqual(created.items.map((item) => item.book), ["甲", "乙"]);
  const afterSuccess = advanceBatch(created, { status: "success" }, "2026-01-01T00:01:00.000Z");
  assert.equal(afterSuccess.currentPosition, 1);
  const afterFailure = advanceBatch(afterSuccess, { status: "failure", failedStage: "voiced", resumeRecommendation: "resume 乙" });
  assert.equal(afterFailure.currentPosition, 2);
  assert.deepEqual(summarizeBatch(afterFailure).items.map(({ book, status }) => ({ book, status })), [
    { book: "甲", status: "success" }, { book: "乙", status: "failure" },
  ]);
  writeBatchState(root, created);
  assert.deepEqual(readBatchState(root, "batch-1"), created);

  assert.equal(DEFAULT_CONFIG.stageRetryLimit.voiced, 3);
  assert.equal(validateConfig({ ...DEFAULT_CONFIG, jianyingCapability: { unicodeCommitAndExport: true, smokeTestedAt: "2026-01-01T00:00:00Z" } }).jianyingApp.length > 0, true);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, stageTimeoutMs: -1 }), /stageTimeoutMs/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, jianyingCapability: { unicodeCommitAndExport: false } }, { requireCapability: true }), /capability probe/i);

  let state = createProductionState({ book: "甲", mode: "book" });
  state = { ...state, currentStage: "illustrated" };
  state = startStageAttempt(state, "voiced", "2026-01-01T00:00:00.000Z");
  assert.equal(state.attempts.voiced.startedAt, "2026-01-01T00:00:00.000Z");
  state = failStage(state, "voiced", new Error("x"));
  state = failStage(state, "voiced", new Error("x"));
  assert.equal(isTerminalFailure(state, 2), true);

  const episode = path.join(root, "episode");
  fs.mkdirSync(path.join(episode, "images"), { recursive: true });
  fs.writeFileSync(path.join(episode, "brief.json"), "{");
  assert.match(validateStageArtifacts("selected", episode, "").join("\n"), /malformed/i);
  fs.writeFileSync(path.join(episode, "brief.json"), JSON.stringify({ display_title: "甲" }));
  assert.match(validateStageArtifacts("selected", episode, "").join("\n"), /author/);
  fs.writeFileSync(path.join(episode, "brief.json"), JSON.stringify({ display_title: "甲", author: "作者" }));
  assert.match(validateStageArtifacts("researched", episode, "").join("\n"), /provenance|source/i);
  fs.writeFileSync(path.join(episode, "brief.json"), JSON.stringify({ display_title: "甲", author: "作者", source_channel: "public", edition_status: "confirmed" }));
  assert.deepEqual(validateStageArtifacts("researched", episode, ""), []);
  fs.writeFileSync(path.join(episode, "prompts.csv"), "name,prompt\nresult-bridge.png,桥接\n");
  for (const name of ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"]) fs.writeFileSync(path.join(episode, "images", name), Buffer.alloc(2048));
  assert.match(validateStageArtifacts("illustrated", episode, "", { probeMedia: () => ({ ok: false, reason: "not decodable" }) }).join("\n"), /not decodable/);
  const validNames = ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"];
  const promptErrors = (csv) => { fs.writeFileSync(path.join(episode, "prompts.csv"), csv); return validateStageArtifacts("illustrated", episode, "", { probeMedia: () => ({ ok: true }) }).join("\n"); };
  assert.match(promptErrors("name,prompt\nresult-bridge.png,桥接\n"), /missing.*atmosphere-1/i);
  assert.match(promptErrors(`name,prompt\n${validNames.map((name) => `${name},x`).join("\n")}\nresult-bridge.png,again\n`), /duplicate.*result-bridge/i);
  assert.match(promptErrors(`name,prompt\n${validNames.map((name) => `${name},${name === "atmosphere-2.png" ? "" : "x"}`).join("\n")}\n`), /empty prompt.*atmosphere-2/i);
  fs.writeFileSync(path.join(episode, "images", "extra.png"), "x");
  assert.match(promptErrors(`name,prompt\n${validNames.map((name) => `${name},x`).join("\n")}\n`), /unexpected image.*extra.png/i);
  fs.rmSync(path.join(episode, "images", "extra.png"));
  assert.match(validateRenderedArtifact(episode, () => ({ ok: false, reason: "corrupt" })).join("\n"), /exactly one MP4/);
  fs.mkdirSync(path.join(episode, "renders"));
  fs.writeFileSync(path.join(episode, "renders", "zero.mp4"), "");
  assert.match(validateRenderedArtifact(episode, () => ({ ok: true })).join("\n"), /non-empty/);
  fs.writeFileSync(path.join(episode, "renders", "second.mp4"), "x");
  assert.match(validateRenderedArtifact(episode, () => ({ ok: true })).join("\n"), /exactly one MP4/);
  fs.rmSync(path.join(episode, "renders", "zero.mp4"));
  assert.match(validateRenderedArtifact(episode, () => ({ ok: false, reason: "corrupt" })).join("\n"), /corrupt/);
  fs.mkdirSync(path.join(episode, "audio"));
  fs.writeFileSync(path.join(episode, "audio", "body-voiceover.mp3"), Buffer.alloc(1024));
  assert.match(validateVoicedArtifact(episode, "2999-01-01T00:00:00Z", () => ({ ok: true })).join("\n"), /stale/);
  assert.match(validateVoicedArtifact(episode, "2000-01-01T00:00:00Z", () => ({ ok: false, reason: "zero duration" })).join("\n"), /zero duration/);

  const report = buildProductionReport({
    book: "甲", voice: "voice", bgm: "bgm", output: "renders/final.mp4", subtitleCount: 18, requiredImageCount: 4,
    enforcedAudio: { introVoice: true, bodyVoice: true, bgm: true, gearSfx: true },
    probe: { streams: [{ codec_type: "video", codec_name: "h264", width: 720, height: 960, avg_frame_rate: "30/1" }, { codec_type: "audio", codec_name: "aac" }], format: { duration: "50" } },
  });
  assert.equal(report.subtitleCount, 18);
  assert.deepEqual(report.enforcedAudio, { introVoice: true, bodyVoice: true, bgm: true, gearSfx: true });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("final findings tests: ok");
