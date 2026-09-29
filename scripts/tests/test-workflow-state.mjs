import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fingerprintFile } from "../lib/media-validation.mjs";
import {
  beginWorkflowStep,
  completeWorkflowStep,
  assertRenderTimingPreflight,
  failWorkflowStep,
  reconcileWorkflowState,
  revalidateWorkflowStep,
  workflowNextActions,
} from "../lib/workflow-state.mjs";
import { validateBodyScript } from "../lib/script-policy.mjs";

assert.deepEqual(validateBodyScript([
  { order: "1", text: "第一句" },
  { order: "2", text: "第二句" },
]).errors, []);
assert.deepEqual(validateBodyScript([
  { order: "1", text: "《测试书》" },
  { order: "2", text: "第一句" },
], { episodeTitle: "测试书" }).errors, []);
assert.match(validateBodyScript([
  { order: "1", text: "第一句" },
  { order: "2", text: "第二句" },
], { episodeTitle: "测试书" }).errors.join("；"), /第一行必须是书名/u);
for (const rows of [
  [{ order: "1", text: "第一句" }, { order: "1", text: "第二句" }],
  [{ order: "1", text: "第一句" }, { order: "3", text: "第二句" }],
  [{ order: "1.5", text: "第一句" }],
]) {
  assert.match(validateBodyScript(rows).errors.join("；"), /order 必须唯一且连续/u);
}

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
  "version,order,text,duration_hint\nA,1,《测试书》,2\nA,2,第一句,2\nA,3,第二句,2\n",
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
  captions: [{ order: 1, start: 0, end: 0.4 }, { order: 2, start: 0.4, end: 1.2 }, { order: 3, start: 1.2, end: 2 }],
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
runFfmpeg([
  "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=2",
  "-codec:a", "libmp3lame", "-b:a", "96k", voicePath,
]);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.voiced.status, "valid", "manual voice episodes remain valid when no generated intro pair exists");

fs.writeFileSync(timingsPath, JSON.stringify({
  scriptVersion: "A",
  audioFingerprint: fingerprintFile(voicePath),
  alignment: {
    method: "speech-duration-estimate",
    requiresAgentReview: true,
  },
  captions: [{ order: 1, start: 0, end: 0.4 }, { order: 2, start: 0.4, end: 1.2 }, { order: 3, start: 1.2, end: 2 }],
}));
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.timed.status, "valid");
assert.equal(state.steps.timed.quality, "degraded");
assert.equal(
  workflowNextActions(episodeDir, state).some((action) => action.step === "timed" && action.action === "review"),
  true,
);
fs.writeFileSync(timingsPath, JSON.stringify({
  scriptVersion: "A",
  audioFingerprint: fingerprintFile(voicePath),
  alignment: { method: "silence-segments", requiresAgentReview: false },
  captions: [{ order: 1, start: 0, end: 2 }],
}));
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.timed.status, "stale", "timings must cover every current script row");
fs.writeFileSync(timingsPath, JSON.stringify({
  scriptVersion: "A",
  audioFingerprint: fingerprintFile(voicePath),
  alignment: { method: "silence-segments", requiresAgentReview: false },
  captions: [{ order: 1, start: 0, end: 0.4 }, { order: 2, start: 0.4, end: 1.2 }, { order: 3, start: 1.2, end: 2 }],
}));
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.timed.status, "valid");

const writeTimingCaptions = (captions) => fs.writeFileSync(timingsPath, JSON.stringify({
  scriptVersion: "A",
  audioFingerprint: fingerprintFile(voicePath),
  alignment: { method: "silence-segments", requiresAgentReview: false },
  captions,
}));
const malformedCaptions = [
  [{ order: 1, start: null, end: 0.4 }, { order: 2, start: 0.4, end: 1.2 }, { order: 3, start: 1.2, end: 2 }],
  [{ order: 1, start: -0.1, end: 0.4 }, { order: 2, start: 0.4, end: 1.2 }, { order: 3, start: 1.2, end: 2 }],
  [{ order: 1, start: 0, end: 0.4 }, { order: 2, start: 0.4, end: 1.2 }, { order: 3, start: 1.2, end: 1.2 }],
  [{ order: 1, start: 0.4, end: 0.8 }, { order: 2, start: 0, end: 1.2 }, { order: 3, start: 1.2, end: 2 }],
  [{ order: 1, start: 0, end: 1.8 }, { order: 2, start: 1, end: 1.5 }, { order: 3, start: 1.5, end: 2 }],
  [{ order: 1, start: "0", end: 0.4 }, { order: 2, start: 0.4, end: 1.2 }, { order: 3, start: 1.2, end: 2 }],
];
for (const captions of malformedCaptions) {
  writeTimingCaptions(captions);
  state = reconcileWorkflowState(episodeDir);
  assert.equal(state.steps.timed.status, "stale", "invalid or backward timing must be stale");
}
fs.writeFileSync(timingsPath, "{broken");
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.timed.status, "stale", "malformed timing JSON must be stale");
writeTimingCaptions([
  { order: 1, start: 0, end: 0.5 },
  { order: 2, start: 0.5, end: 1.4 },
  { order: 3, start: 1.4, end: 2 },
]);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.timed.status, "valid", "monotonic overlapping captions remain valid");

const lastSuccessfulTimings = fs.readFileSync(timingsPath);
beginWorkflowStep(episodeDir, "timed");
assert.throws(
  () => assertRenderTimingPreflight(episodeDir),
  (error) => error.code === "workflow_render_preflight_blocked"
    && error.details.diagnosticCode === "timing_generation_in_progress",
);
const runningNextActions = workflowNextActions(episodeDir);
assert.equal(runningNextActions.some((action) => action.step === "rendered" && action.action === "run"), false);
assert.equal(runningNextActions.some((action) => action.step === "rendered" && action.action === "blocked"), true);
const runningWorkflowNext = spawnSync(
  process.execPath,
  [path.resolve("scripts/workflow-state.mjs"), "next", "测试书"],
  { cwd: root, encoding: "utf8", shell: false },
);
assert.equal(runningWorkflowNext.status, 0, runningWorkflowNext.stderr);
const runningActions = JSON.parse(runningWorkflowNext.stdout).nextActions;
assert.equal(runningActions.some((action) => action.step === "rendered" && action.action === "run"), false);
assert.equal(runningActions.some((action) => action.step === "rendered" && action.action === "blocked"), true);
for (const scriptName of ["render-episode-final.mjs", "create-episode-preview.mjs"]) {
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts", scriptName), "测试书"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  assert.notEqual(result.status, 0, `${scriptName} must wait while timing is running`);
  assert.match(result.stderr, /Timing generation is still running/u);
}
state = failWorkflowStep(episodeDir, "timed", {
  code: "voiceover_script_alignment_failed",
  error: "Voiceover does not match the approved script",
  recoverable: true,
  details: { scriptVersion: "A", alignment: { issues: [{ message: "row 2 mismatch" }] } },
  nextActions: ["Replace the voiceover and rerun timing generation."],
});
assert.deepEqual(fs.readFileSync(timingsPath), lastSuccessfulTimings, "failed alignment must preserve the prior timings file");
assert.throws(
  () => assertRenderTimingPreflight(episodeDir),
  (error) => error.code === "workflow_render_preflight_blocked"
    && error.details.diagnosticCode === "voiceover_script_alignment_failed",
);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.timed.status, "needs_attention");
assert.equal(state.steps.timed.diagnostic.code, "voiceover_script_alignment_failed");
const workflowNext = spawnSync(
  process.execPath,
  [path.resolve("scripts/workflow-state.mjs"), "next", "测试书"],
  { cwd: root, encoding: "utf8", shell: false },
);
assert.equal(workflowNext.status, 0, workflowNext.stderr);
const nextActions = JSON.parse(workflowNext.stdout).nextActions;
assert.equal(nextActions.some((action) => action.step === "rendered" && action.action === "run"), false);
assert.equal(nextActions.some((action) => action.step === "rendered" && action.action === "blocked"), true);
assert.throws(
  () => beginWorkflowStep(episodeDir, "rendered", { enforceDependencies: true }),
  (error) => error.code === "workflow_render_preflight_blocked"
    && error.details.diagnosticCode === "voiceover_script_alignment_failed",
);
for (const scriptName of ["render-episode-final.mjs", "create-episode-preview.mjs"]) {
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts", scriptName), "测试书"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  assert.notEqual(result.status, 0, `${scriptName} must stop after alignment mismatch`);
  assert.match(result.stderr, /last voiceover failed script alignment/u);
}
assert.deepEqual(fs.readFileSync(timingsPath), lastSuccessfulTimings, "render preflight must leave prior timings intact");
assert.equal(fs.readdirSync(rendersDir).length, 0, "blocked render must not create a render artifact");

const degradedTimings = JSON.parse(lastSuccessfulTimings.toString("utf8"));
degradedTimings.alignment.requiresAgentReview = true;
fs.writeFileSync(timingsPath, JSON.stringify(degradedTimings));
beginWorkflowStep(episodeDir, "timed");
state = completeWorkflowStep(episodeDir, "timed", { quality: "degraded" });
assert.equal(state.steps.timed.quality, "degraded");
assert.equal(state.steps.timed.diagnostic, null, "successful timing generation clears the alignment failure diagnostic");
assert.doesNotThrow(() => assertRenderTimingPreflight(episodeDir));
assert.equal(workflowNextActions(episodeDir, state).some((action) => action.step === "rendered" && action.action === "blocked"), false);
assert.equal(workflowNextActions(episodeDir, state).some((action) => action.step === "rendered" && action.action === "run"), true);
const recoveredWorkflowNext = spawnSync(
  process.execPath,
  [path.resolve("scripts/workflow-state.mjs"), "next", "测试书"],
  { cwd: root, encoding: "utf8", shell: false },
);
assert.equal(recoveredWorkflowNext.status, 0, recoveredWorkflowNext.stderr);
assert.equal(
  JSON.parse(recoveredWorkflowNext.stdout).nextActions.some((action) => action.step === "rendered" && action.action === "run"),
  true,
);
fs.rmSync(timingsPath);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.timed.status, "stale");
assert.doesNotThrow(() => assertRenderTimingPreflight(episodeDir));
fs.writeFileSync(timingsPath, lastSuccessfulTimings);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.timed.status, "valid");

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

const generatedIntroPath = path.join(audioDir, "intro-voiceover.generated.wav");
const generatedIntroManifestPath = path.join(audioDir, "intro-voiceover.generated.json");
runFfmpeg([
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
  "-c:a", "pcm_s16le", generatedIntroPath,
]);
fs.writeFileSync(generatedIntroManifestPath, JSON.stringify({ test: "generated intro fingerprint" }));
state = completeWorkflowStep(episodeDir, "voiced");
state = completeWorkflowStep(episodeDir, "rendered", { enforceDependencies: true });
runFfmpeg([
  "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000:duration=1",
  "-c:a", "pcm_s16le", generatedIntroPath,
]);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.voiced.status, "stale", "editing a generated intro must stale the weak-trust voiced step");
assert.equal(state.steps.rendered.status, "stale", "editing a generated intro must stale the render that selected it");
state = completeWorkflowStep(episodeDir, "voiced");
state = completeWorkflowStep(episodeDir, "rendered", { enforceDependencies: true });
fs.writeFileSync(generatedIntroManifestPath, JSON.stringify({ test: "edited generated intro manifest" }));
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.voiced.status, "stale", "editing the generated intro manifest must stale the voiced step");
assert.equal(state.steps.rendered.status, "stale", "editing the selected intro manifest must stale the render");
fs.rmSync(generatedIntroPath);
fs.rmSync(generatedIntroManifestPath);

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

fs.appendFileSync(path.join(episodeDir, "script.csv"), "A,4,第三句,2\n");
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.script_validated.status, "valid");
for (const step of ["script_approved", "illustrated", "voiced", "timed", "rendered", "verified", "delivered"]) {
  assert.equal(state.steps[step].status, "stale", `${step} should be stale after script changes`);
}
assert.equal(fs.existsSync(renderPath), true);

const reviewEvidence = "illustrated@A:逐张检查 2/2 张图片，并确认每张均适配当前稿";
const voiceReviewEvidence = "voiced@A:逐句核听 4/4 行，并确认全部与当前稿逐行一致";
const revalidateWithoutApproval = spawnSync(
  process.execPath,
  [path.resolve("scripts/workflow-state.mjs"), "revalidate", "测试书", "illustrated", "--evidence", reviewEvidence],
  { cwd: root, encoding: "utf8", shell: false },
);
assert.notEqual(revalidateWithoutApproval.status, 0);
assert.match(revalidateWithoutApproval.stderr, /current validated and approved script/u);
assert.throws(
  () => revalidateWorkflowStep(episodeDir, "voiced", { evidence: voiceReviewEvidence }),
  /current validated and approved script/u,
);

const reapproveScript = spawnSync(
  process.execPath,
  [path.resolve("scripts/workflow-state.mjs"), "approve", "测试书"],
  { cwd: root, encoding: "utf8", shell: false },
);
assert.equal(reapproveScript.status, 0, reapproveScript.stderr);
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.illustrated.status, "stale");
assert.equal(state.steps.voiced.status, "stale");
for (const invalidEvidence of [
  reviewEvidence,
  "voiced@old:逐句核听 3/3 行，并确认全部与当前稿逐行一致",
  "voiced@A:检查过音频",
  "voiced@A:逐句核听 2/3 行，并确认全部与当前稿逐行一致",
]) {
  assert.throws(
    () => revalidateWorkflowStep(episodeDir, "voiced", { evidence: invalidEvidence }),
    /does not match the voiced review/u,
  );
}

const promptsPath = path.join(episodeDir, "prompts.csv");
const savedPromptsPath = path.join(episodeDir, "prompts.csv.saved");
fs.renameSync(promptsPath, savedPromptsPath);
const revalidateMissingOutput = spawnSync(
  process.execPath,
  [path.resolve("scripts/workflow-state.mjs"), "revalidate", "测试书", "illustrated", "--evidence", reviewEvidence],
  { cwd: root, encoding: "utf8", shell: false },
);
assert.notEqual(revalidateMissingOutput.status, 0);
assert.match(revalidateMissingOutput.stderr, /outputs for illustrated are missing or invalid/u);
fs.renameSync(savedPromptsPath, promptsPath);

for (const step of ["illustrated", "voiced"]) {
  const evidence = step === "voiced" ? voiceReviewEvidence : reviewEvidence;
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/workflow-state.mjs"), "revalidate", "测试书", step, "--evidence", evidence],
    { cwd: root, encoding: "utf8", shell: false },
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.steps[step].status, "valid");
  assert.equal(summary.steps[step].revalidation.step, step);
  assert.equal(summary.steps[step].revalidation.scriptVersion, "A");
  assert.equal(summary.steps[step].revalidation.checkedCount, step === "voiced" ? 4 : 2);
  assert.equal(summary.steps[step].revalidation.evidence, evidence);
}
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.illustrated.status, "valid");
assert.equal(state.steps.voiced.status, "valid");
assert.equal(state.steps.timed.status, "stale", "old three-line timing must not validate against the new four-line script");

fs.writeFileSync(path.join(episodeDir, "script.csv"),
  "version,order,text,duration_hint\nA,1,《测试书》,2\nA,2,重复序号,2\nA,2,第三句,2\nA,4,第四句,2\n");
state = reconcileWorkflowState(episodeDir);
assert.equal(state.steps.script_validated.status, "stale", "duplicate order values must invalidate script validation");

fs.rmSync(root, { recursive: true, force: true });
console.log("workflow state tests: ok");
