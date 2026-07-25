import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

let state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.selected.status, "valid");
assert.equal(state.steps.researched.status, "valid");
assert.equal(state.steps.script_validated.status, "valid");
assert.equal(state.steps.script_approved.status, "ready");

state = completeWorkflowStep(episodeDir, "script_approved", { enforceDependencies: true });
assert.equal(state.steps.script_approved.status, "valid");
assert.equal(fs.existsSync(path.join(episodeDir, "script-approval.json")), true);

fs.writeFileSync(
  path.join(episodeDir, "prompts.csv"),
  "name,prompt\nresult-bridge.png,bridge\natmosphere-1.png,one\natmosphere-2.png,two\natmosphere-3.png,three\n",
);
for (const name of ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"]) {
  fs.writeFileSync(path.join(imagesDir, name), `image:${name}`);
}
state = completeWorkflowStep(episodeDir, "illustrated", { enforceDependencies: true });
assert.equal(state.steps.illustrated.status, "valid");

const voicePath = path.join(audioDir, "body-voiceover.mp3");
fs.writeFileSync(voicePath, Buffer.alloc(2048, 1));
state = completeWorkflowStep(episodeDir, "voiced", { enforceDependencies: true });
assert.equal(state.steps.voiced.status, "valid");

fs.writeFileSync(path.join(audioDir, "body-timings.json"), JSON.stringify({
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

state = beginWorkflowStep(episodeDir, "voiced");
state = failWorkflowStep(episodeDir, "voiced", {
  code: "subprocess_failed",
  error: "ffmpeg failed",
  recoverable: true,
  nextActions: ["Retry the same step."],
});
assert.equal(state.steps.voiced.status, "needs_attention");
assert.equal(state.steps.voiced.activeArtifactValid, true);
assert.equal(state.steps.voiced.attempts, 1);
assert.equal(workflowNextActions(episodeDir, state)[0].action, "diagnose_and_retry");

beginWorkflowStep(episodeDir, "voiced");
state = completeWorkflowStep(episodeDir, "voiced");
assert.equal(state.steps.voiced.status, "valid");
assert.equal(state.steps.voiced.attempts, 2);

const renderPath = path.join(rendersDir, "final.mp4");
fs.writeFileSync(renderPath, Buffer.alloc(4096, 2));
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
  agentReview: { status: "passed" },
  verified: true,
}));
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.rendered.status, "valid");
assert.equal(state.steps.verified.status, "valid");
state = completeWorkflowStep(episodeDir, "delivered", { enforceDependencies: true });
assert.equal(state.steps.delivered.status, "valid");
assert.equal(fs.existsSync(path.join(episodeDir, "delivery.json")), true);

fs.writeFileSync(path.join(episodeDir, "workflow-state.json"), "{broken");
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.selected.status, "valid");
assert.equal(state.steps.researched.status, "valid");
assert.equal(state.steps.script_validated.status, "valid");
assert.equal(state.steps.script_approved.status, "valid");
assert.equal(state.steps.delivered.status, "valid");
assert.equal(
  fs.readdirSync(episodeDir).some((name) => name.startsWith("workflow-state.corrupt-")),
  true,
);

fs.appendFileSync(path.join(episodeDir, "script.csv"), "A,3,第三句,2\n");
state = reconcileWorkflowState(episodeDir);
for (const step of ["script_validated", "script_approved", "illustrated", "voiced", "timed", "rendered", "verified", "delivered"]) {
  assert.equal(state.steps[step].status, "stale", `${step} should be stale after script changes`);
}
assert.equal(fs.existsSync(renderPath), true);

fs.rmSync(root, { recursive: true, force: true });
console.log("workflow state tests: ok");
