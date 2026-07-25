import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fingerprintFile } from "../lib/media-validation.mjs";
import {
  beginWorkflowStep,
  completeWorkflowStep,
  failWorkflowStep,
  reconcileWorkflowState,
  workflowNextActions,
} from "../lib/workflow-state.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-workflow-state-"));
const episodeDir = path.join(root, "episodes", "测试书");
const audioDir = path.join(episodeDir, "audio");
const imagesDir = path.join(episodeDir, "images");
const rendersDir = path.join(episodeDir, "renders");
fs.mkdirSync(audioDir, { recursive: true });
fs.mkdirSync(imagesDir, { recursive: true });
fs.mkdirSync(rendersDir, { recursive: true });
const runFfmpeg = (args) => {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
};

fs.writeFileSync(path.join(episodeDir, "brief.json"), JSON.stringify({
  display_title: "测试书",
  author: "测试作者",
  source_channel: "public",
  edition_status: "confirmed",
  activeScriptVersion: "A",
}));
fs.writeFileSync(
  path.join(episodeDir, "script.csv"),
  "version,order,text,duration_hint\nA,1,第一句,2\nA,2,第二句,2\n",
);
fs.writeFileSync(path.join(episodeDir, "workflow-state.json"), JSON.stringify({
  schemaVersion: 1,
  episode: "测试书",
  steps: {
    selected: { status: "valid", inferred: true },
    researched: { status: "valid", activeArtifactValid: true },
  },
}));

let state = reconcileWorkflowState(episodeDir);
assert.equal(state.schemaVersion, 2);
assert.equal(state.steps.book_ready.status, "valid");
assert.equal(state.steps.script_validated.status, "valid");
assert.equal(state.steps.script_approved.status, "ready");
assert.equal("selected" in state.steps, false);
assert.equal("inferred" in state.steps.book_ready, false);
assert.equal("activeArtifactValid" in state.steps.book_ready, false);
assert.throws(
  () => beginWorkflowStep(episodeDir, "voiced", { enforceDependencies: true }),
  /requires valid steps: script_approved/u,
);

const approval = spawnSync(
  process.execPath,
  [path.resolve("scripts/workflow-state.mjs"), "approve", "测试书"],
  { cwd: root, encoding: "utf8", shell: false },
);
assert.equal(approval.status, 0, approval.stderr);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.script_approved.status, "valid");
assert.equal(fs.existsSync(path.join(episodeDir, "script-approval.json")), true);
const legacyRecord = spawnSync(
  process.execPath,
  [path.resolve("scripts/workflow-state.mjs"), "record", "测试书", "script_approved"],
  { cwd: root, encoding: "utf8", shell: false },
);
assert.equal(legacyRecord.status, 0, legacyRecord.stderr);
assert.match(legacyRecord.stderr, /Deprecated/u);

const externalVoicePath = path.join(root, "external-voice.mp3");
fs.writeFileSync(externalVoicePath, Buffer.alloc(2048, 3));
const timingsPath = path.join(audioDir, "body-timings.json");
fs.writeFileSync(timingsPath, JSON.stringify({
  scriptVersion: "A",
  audio: path.relative(root, externalVoicePath),
  audioFingerprint: fingerprintFile(externalVoicePath),
  alignment: { method: "external", requiresAgentReview: true },
  captions: [{ order: 1, start: 0, end: 2 }],
}));
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.voiced.status, "ready");
assert.equal(state.steps.timed.status, "valid");
fs.rmSync(timingsPath);

fs.writeFileSync(
  path.join(episodeDir, "prompts.csv"),
  "name,prompt\nresult-bridge.png,bridge\natmosphere-1.png,one\natmosphere-2.png,two\natmosphere-3.png,three\n",
);
for (const name of ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"]) {
  fs.writeFileSync(
    path.join(imagesDir, name),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
}
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.illustrated.status, "valid");
runFfmpeg([
  "-f", "lavfi", "-i", "color=c=blue:s=12x16",
  "-frames:v", "1", path.join(imagesDir, "atmosphere-1.png"),
]);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.illustrated.status, "valid");
assert.equal(state.steps.illustrated.quality, "review_required");

const voicePath = path.join(audioDir, "body-voiceover.mp3");
runFfmpeg([
  "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=2",
  "-codec:a", "libmp3lame", "-b:a", "96k", voicePath,
]);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.voiced.status, "valid");

fs.writeFileSync(timingsPath, JSON.stringify({
  scriptVersion: "A",
  audioFingerprint: fingerprintFile(voicePath),
  alignment: {
    method: "speech-duration-estimate",
    requiresAgentReview: true,
  },
  captions: [{ order: 1, start: 0, end: 2 }],
}));
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.timed.status, "valid");
assert.equal(state.steps.timed.quality, "degraded");
assert.equal(
  workflowNextActions(episodeDir, state).some((action) => action.step === "timed" && action.action === "review"),
  true,
);

state = beginWorkflowStep(episodeDir, "voiced");
state = failWorkflowStep(episodeDir, "voiced", {
  code: "subprocess_failed",
  error: "ffmpeg failed",
  recoverable: true,
  nextActions: ["Retry the same step."],
});
assert.equal(state.steps.voiced.status, "needs_attention");
assert.equal(state.steps.voiced.attempts, 1);
assert.equal(workflowNextActions(episodeDir, state)[0].activeArtifactValid, true);

beginWorkflowStep(episodeDir, "voiced");
state = completeWorkflowStep(episodeDir, "voiced");
assert.equal(state.steps.voiced.status, "valid");
assert.equal(state.steps.voiced.attempts, 2);

const renderPath = path.join(rendersDir, "final.mp4");
runFfmpeg([
  "-f", "lavfi", "-i", "color=c=black:s=720x960:r=30:d=1",
  "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=1",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", renderPath,
]);
fs.writeFileSync(path.join(episodeDir, "production-report.json"), JSON.stringify({
  scriptVersion: "A",
  bgm: "",
  output: "renders/final.mp4",
  technicalChecks: { passed: true },
  agentReview: { status: "pending" },
  verified: false,
}));
state = completeWorkflowStep(episodeDir, "rendered", { enforceDependencies: true });
assert.equal(state.steps.rendered.status, "valid");
assert.equal(state.steps.verified.status, "ready");

fs.writeFileSync(path.join(episodeDir, "production-report.json"), JSON.stringify({
  scriptVersion: "A",
  bgm: "",
  output: "renders/final.mp4",
  technicalChecks: { passed: true },
  agentReview: { status: "failed" },
  verified: true,
}));
state = reconcileWorkflowState(episodeDir);
assert.notEqual(state.steps.verified.status, "valid");

fs.writeFileSync(path.join(episodeDir, "production-report.json"), JSON.stringify({
  scriptVersion: "A",
  bgm: "",
  output: "renders/final.mp4",
  technicalChecks: { passed: true },
  agentReview: {
    status: "passed",
    checks: {
      noBlankFrames: true,
      noPlaceholderText: true,
      noSubtitleOverflow: true,
    },
  },
  verified: true,
}));
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.rendered.status, "valid");
assert.equal(state.steps.verified.status, "valid");
assert.equal(state.steps.delivered.status, "ready");
assert.equal(
  workflowNextActions(episodeDir, state).some((action) => action.step === "delivered" && action.action === "run"),
  true,
);

const delivery = spawnSync(
  process.execPath,
  [path.resolve("scripts/workflow-state.mjs"), "deliver", "测试书"],
  { cwd: root, encoding: "utf8", shell: false },
);
assert.equal(delivery.status, 0, delivery.stderr);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.delivered.status, "valid");
assert.equal(workflowNextActions(episodeDir, state).length, 0);

fs.writeFileSync(path.join(episodeDir, "workflow-state.json"), "{broken");
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.book_ready.status, "valid");
assert.equal(state.steps.script_validated.status, "valid");
assert.equal(state.steps.script_approved.status, "valid");
assert.equal(state.steps.verified.status, "valid");
assert.equal(state.steps.delivered.status, "valid");
assert.equal(
  fs.readdirSync(episodeDir).some((name) => name.startsWith("workflow-state.corrupt-")),
  true,
);

fs.appendFileSync(path.join(episodeDir, "script.csv"), "A,3,第三句,2\n");
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.script_validated.status, "valid");
for (const step of ["script_approved", "illustrated", "voiced", "timed", "rendered", "verified", "delivered"]) {
  assert.equal(state.steps[step].status, "stale", `${step} should be stale after script changes`);
}
assert.equal(fs.existsSync(renderPath), true);

fs.rmSync(root, { recursive: true, force: true });
console.log("workflow state tests: ok");
