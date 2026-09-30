import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readCsv } from "./csv.mjs";
import {
  fingerprintFile,
  isFileFingerprintCurrent,
  probeMedia,
  validateVoiceoverArtifact,
} from "./media-validation.mjs";
import { resolveScriptVersion } from "./script-version.mjs";
import { validateBodyScript } from "./script-policy.mjs";
import { getAtmosphereImageNames } from "./body-scenes.mjs";
import { resolveVoiceProfile } from "./voice-profiles.mjs";

export const WORKFLOW_STEPS = Object.freeze([
  "book_ready",
  "script_validated",
  "script_approved",
  "illustrated",
  "voiced",
  "timed",
  "rendered",
  "verified",
  "delivered",
]);

export const WORKFLOW_DEPENDENCIES = Object.freeze({
  book_ready: [],
  script_validated: ["book_ready"],
  script_approved: ["script_validated"],
  illustrated: ["script_approved"],
  voiced: ["script_approved"],
  timed: ["script_approved", "voiced"],
  rendered: ["script_approved", "illustrated", "voiced"],
  verified: ["rendered"],
  delivered: ["verified"],
});

const STATE_FILE = "workflow-state.json";
const RUNNING_TIMEOUT_MS = 30 * 60 * 1000;
function requiredImageNames(episodeDir) {
  const scriptPath = path.join(episodeDir, "script.csv");
  if (!fs.existsSync(scriptPath)) return ["result-bridge.png"];
  const version = resolveScriptVersion(episodeDir);
  const bodyRowCount = readCsv(scriptPath).rows
    .filter((row) => row.version === version && Number(row.order) !== 1)
    .length;
  return ["result-bridge.png", ...getAtmosphereImageNames(bodyRowCount)];
}

function createStep() {
  return {
    status: "pending",
    quality: null,
    attempts: 0,
    inputFingerprint: null,
    outputFingerprint: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    diagnostic: null,
    lastValid: null,
    revalidation: null,
  };
}

export function createWorkflowState(episodeDir, now = new Date().toISOString()) {
  return {
    schemaVersion: 2,
    episode: path.basename(episodeDir),
    steps: Object.fromEntries(WORKFLOW_STEPS.map((step) => [step, createStep()])),
    createdAt: now,
    updatedAt: now,
    reconciledAt: null,
  };
}

function normalizeState(state, episodeDir) {
  if (!state || ![1, 2].includes(state.schemaVersion) || typeof state.steps !== "object") {
    throw new Error("Unsupported or malformed workflow state");
  }
  const stepDefaults = createStep();
  const normalizeStep = (value = {}) => Object.fromEntries(
    Object.keys(stepDefaults).map((key) => [key, key in value ? value[key] : stepDefaults[key]]),
  );
  return {
    ...createWorkflowState(episodeDir, state.createdAt),
    ...state,
    schemaVersion: 2,
    episode: path.basename(episodeDir),
    steps: Object.fromEntries(
      WORKFLOW_STEPS.map((step) => [step, normalizeStep(state.steps[step])]),
    ),
  };
}

function statePath(episodeDir) {
  return path.join(episodeDir, STATE_FILE);
}

function corruptStatePath(episodeDir) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return path.join(episodeDir, `workflow-state.corrupt-${stamp}.json`);
}

function readStateForReconcile(episodeDir) {
  const filePath = statePath(episodeDir);
  if (!fs.existsSync(filePath)) return createWorkflowState(episodeDir);
  try {
    return normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")), episodeDir);
  } catch {
    try {
      fs.renameSync(filePath, corruptStatePath(episodeDir));
    } catch {}
    return createWorkflowState(episodeDir);
  }
}

export function readWorkflowState(episodeDir) {
  return normalizeState(JSON.parse(fs.readFileSync(statePath(episodeDir), "utf8")), episodeDir);
}

function renderTimingBlocker(episodeDir) {
  try {
    const timed = readWorkflowState(episodeDir).steps.timed;
    if (timed.status === "running") {
      return {
        code: "timing_generation_in_progress",
        error: "Timing generation is still running; wait for it to finish before rendering.",
        timedStatus: timed.status,
        nextActions: ["Wait for timing generation to finish, then retry preview or render."],
      };
    }
  } catch {}
  return null;
}

export function assertRenderTimingPreflight(episodeDir) {
  const blocker = renderTimingBlocker(episodeDir);
  if (!blocker) return;
  const error = new Error(blocker.error || "Rendering is blocked by the timed step.");
  error.code = "workflow_render_preflight_blocked";
  error.details = {
    blockedBy: "timed",
    timedStatus: blocker.timedStatus || "needs_attention",
    diagnosticCode: blocker.code || "timing_generation_in_progress",
    ...(blocker.details || {}),
  };
  error.nextActions = blocker.nextActions || ["Wait for timing generation to finish, then retry preview or render."];
  throw error;
}

export function writeWorkflowState(episodeDir, state) {
  fs.mkdirSync(episodeDir, { recursive: true });
  const destination = statePath(episodeDir);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function validPngArtifact(filePath) {
  try {
    const header = fs.readFileSync(filePath).subarray(0, 24);
    return header.length === 24
      && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && header.subarray(12, 16).toString("ascii") === "IHDR"
      && header.readUInt32BE(16) > 0
      && header.readUInt32BE(20) > 0;
  } catch {
    return false;
  }
}

function validVoiceArtifact(filePath) {
  try {
    validateVoiceoverArtifact(filePath);
    return true;
  } catch {
    return false;
  }
}

function validRenderArtifact(filePath) {
  try {
    const media = probeMedia(filePath);
    const video = media.streams?.some((stream) => stream.codec_type === "video");
    const audio = media.streams?.some((stream) => stream.codec_type === "audio");
    return Boolean(video && audio && Number(media.format?.duration || 0) > 0);
  } catch {
    return false;
  }
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function collectFiles(targetPath) {
  if (!fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(targetPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => collectFiles(path.join(targetPath, entry.name)));
}

function fingerprintBundle(root, targets) {
  const files = targets
    .flatMap((target) => collectFiles(path.resolve(root, target)))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .sort();
  if (!files.length) return null;
  const hash = createHash("sha256");
  for (const filePath of files) {
    const fingerprint = fingerprintFile(filePath);
    hash.update(path.relative(root, filePath));
    hash.update(String(fingerprint.size));
    hash.update(fingerprint.sha256);
  }
  return hash.digest("hex");
}

function activeScriptVersion(episodeDir) {
  try {
    return resolveScriptVersion(episodeDir);
  } catch {
    return "";
  }
}

function readReport(episodeDir) {
  return readJson(path.join(episodeDir, "production-report.json"));
}

function renderRelativePath(episodeDir) {
  const report = readReport(episodeDir);
  return typeof report?.output === "string" ? report.output : "";
}

function generatedIntroTargets(episodeDir) {
  const audioDir = path.join(episodeDir, "audio");
  const introPath = path.join(audioDir, "intro-voiceover.generated.wav");
  const manifestPath = path.join(audioDir, "intro-voiceover.generated.json");
  if (!fs.existsSync(introPath) || !fs.existsSync(manifestPath)) return [];
  return [
    path.join("audio", path.basename(introPath)),
    path.join("audio", path.basename(manifestPath)),
  ];
}

function timingAudioPath(episodeDir, timings = readJson(path.join(episodeDir, "audio", "body-timings.json"))) {
  const defaultPath = path.join(episodeDir, "audio", "body-voiceover.mp3");
  if (!timings?.audio) return defaultPath;
  return path.resolve(episodeDir, "..", "..", timings.audio);
}

function reportVerified(report) {
  const checks = report?.agentReview?.checks;
  return Boolean(
    report?.verified === true
    && report?.agentReview?.status === "passed"
    && checks?.noBlankFrames === true
    && checks?.noPlaceholderText === true
    && checks?.noSubtitleOverflow === true,
  );
}

function inputTargets(episodeDir, step) {
  const report = readReport(episodeDir);
  const timings = readJson(path.join(episodeDir, "audio", "body-timings.json"));
  const repositoryRoot = path.resolve(episodeDir, "..", "..");
  const bgm = report?.inputArtifacts?.bgm?.path
    ? path.resolve(repositoryRoot, report.inputArtifacts.bgm.path)
    : report?.bgm ? path.join("..", "..", "assets", "bgm", report.bgm) : "";
  const targets = {
    book_ready: [],
    script_validated: ["brief.json", "script.csv"],
    script_approved: ["script.csv"],
    illustrated: ["script.csv", "prompts.csv"],
    // Generated intro artifacts are optional provenance inputs: their absence
    // leaves manual voice episodes unchanged, while edits to a generated pair
    // invalidate the weak-trust voice step until it is explicitly completed.
    voiced: ["script.csv", ...generatedIntroTargets(episodeDir)],
    timed: ["script.csv", timingAudioPath(episodeDir, timings)],
    rendered: [
      "script.csv",
      "prompts.csv",
      "images",
      path.join("audio", "body-voiceover.mp3"),
      ...generatedIntroTargets(episodeDir),
      path.join("audio", "body-timings.json"),
      path.join("..", "..", "templates", "shared-video-template"),
      path.join("..", "..", "assets", "sfx", "gear-scroll.mp3"),
      bgm,
    ].filter(Boolean),
    verified: [renderRelativePath(episodeDir), "production-report.json"].filter(Boolean),
    delivered: [renderRelativePath(episodeDir), "production-report.json"].filter(Boolean),
  };
  return targets[step] || [];
}

function outputTargets(episodeDir, step) {
  if (step === "illustrated") {
    return ["prompts.csv", ...requiredImageNames(episodeDir).map((name) => path.join("images", name))];
  }
  const targets = {
    book_ready: ["brief.json"],
    script_validated: ["script.csv"],
    script_approved: ["script-approval.json"],
    voiced: [path.join("audio", "body-voiceover.mp3"), ...generatedIntroTargets(episodeDir)],
    timed: [path.join("audio", "body-timings.json")],
    rendered: [renderRelativePath(episodeDir)].filter(Boolean),
    verified: ["production-report.json"],
    delivered: ["delivery.json"],
  };
  return targets[step] || [];
}

export function workflowInputFingerprint(episodeDir, step) {
  const fingerprint = fingerprintBundle(episodeDir, inputTargets(episodeDir, step));
  if (step !== "voiced" && step !== "rendered") return fingerprint;

  const repositoryRoot = path.resolve(episodeDir, "..", "..");
  const profile = resolveVoiceProfile(repositoryRoot, episodeDir);
  const voiceAssets = step === "voiced"
    ? [profile.introPath, profile.referencePath]
    : [profile.introPath];
  const voiceFingerprint = fingerprintBundle(repositoryRoot, voiceAssets);
  return createHash("sha256")
    .update(fingerprint || "")
    .update(`\0voice-profile:${profile.id}\0${voiceFingerprint || ""}`)
    .digest("hex");
}

export function workflowOutputFingerprint(episodeDir, step) {
  return fingerprintBundle(episodeDir, outputTargets(episodeDir, step));
}

function assessArtifacts(episodeDir, step) {
  const brief = readJson(path.join(episodeDir, "brief.json"));
  const version = activeScriptVersion(episodeDir);
  const voicePath = path.join(episodeDir, "audio", "body-voiceover.mp3");
  const timings = readJson(path.join(episodeDir, "audio", "body-timings.json"));
  const report = readReport(episodeDir);
  const delivery = readJson(path.join(episodeDir, "delivery.json"));
  const renderPath = renderRelativePath(episodeDir);
  const renderFile = renderPath ? path.join(episodeDir, renderPath) : "";
  const scriptPath = path.join(episodeDir, "script.csv");
  const scriptApproval = readJson(path.join(episodeDir, "script-approval.json"));

  if (step === "book_ready") {
    const valid = Boolean(
      brief
      && String(brief.display_title || brief.displayTitle || brief.title || "").trim()
      && String(brief.author || "").trim()
      && String(brief.source_channel || brief.source || brief.provenance || "").trim()
      && String(brief.edition_status || brief.edition || brief.version_status || "").trim()
    );
    return { valid, trust: "strong", quality: "pass" };
  }

  if (step === "script_validated") {
    if (!fs.existsSync(scriptPath) || !version) return { valid: false, trust: "strong", quality: null };
    try {
      const rows = readCsv(scriptPath).rows
        .filter((row) => row.version === version)
        .sort((left, right) => Number(left.order) - Number(right.order));
      const episodeTitle = String(brief?.display_title || brief?.displayTitle || brief?.title || "").trim();
      const valid = rows.length > 0
        && Boolean(episodeTitle)
        && validateBodyScript(rows, { episodeTitle }).errors.length === 0;
      return { valid, trust: "strong", quality: valid ? "pass" : null };
    } catch {
      return { valid: false, trust: "strong", quality: null };
    }
  }

  if (step === "script_approved") {
    const valid = Boolean(
      scriptApproval
      && scriptApproval.scriptVersion === version
      && isFileFingerprintCurrent(scriptPath, scriptApproval.scriptFingerprint),
    );
    return { valid, trust: "strong", quality: valid ? "pass" : null };
  }

  if (step === "illustrated") {
    const valid = requiredImageNames(episodeDir).every(
      (name) => validPngArtifact(path.join(episodeDir, "images", name)),
    ) && fs.existsSync(path.join(episodeDir, "prompts.csv"));
    return { valid, trust: "weak", quality: "review_required" };
  }

  if (step === "voiced") {
    const valid = validVoiceArtifact(voicePath);
    return { valid, trust: "weak", quality: "review_required" };
  }

  if (step === "timed") {
    const timingVoice = timingAudioPath(episodeDir, timings);
    let scriptOrders = [];
    try {
      scriptOrders = readCsv(scriptPath).rows
        .filter((row) => row.version === version)
        .sort((left, right) => Number(left.order) - Number(right.order))
        .map((row) => Number(row.order));
    } catch {}
    const expectedCaptionOrders = scriptOrders.filter((order) => order !== 1);
    const captionOrders = Array.isArray(timings?.captions)
      ? timings.captions.map((caption) => Number(caption.order))
      : [];
    const captionsMatchScript = expectedCaptionOrders.length > 0
      && captionOrders.length === expectedCaptionOrders.length
      && expectedCaptionOrders.every((order, index) => captionOrders[index] === order);
    const captionsHaveValidChronology = captionsMatchScript
      && timings.captions.every((caption, index) => {
        if (
          typeof caption.start !== "number"
          || !Number.isFinite(caption.start)
          || caption.start < 0
          || typeof caption.end !== "number"
          || !Number.isFinite(caption.end)
          || caption.end < 0
          || caption.start >= caption.end
        ) return false;
        if (index === 0) return true;
        const previous = timings.captions[index - 1];
        return caption.start >= previous.start && caption.end >= previous.end;
      });
    const valid = Boolean(
      timings
      && timings.scriptVersion === version
      && isFileFingerprintCurrent(scriptPath, timings.scriptFingerprint)
      && isFileFingerprintCurrent(timingVoice, timings.audioFingerprint)
      && captionsHaveValidChronology,
    );
    return {
      valid,
      trust: "strong",
      quality: valid && timings.alignment?.requiresAgentReview ? "degraded" : valid ? "pass" : null,
    };
  }

  if (step === "rendered") {
    const valid = Boolean(
      report?.technicalChecks?.passed
      && report.scriptVersion === version
      && renderFile
      && validRenderArtifact(renderFile),
    );
    return { valid, trust: "weak", quality: valid ? "review_required" : null };
  }

  if (step === "verified") {
    const valid = reportVerified(report);
    return { valid, trust: "strong", quality: valid ? "pass" : null };
  }

  if (step === "delivered") {
    const valid = Boolean(
      reportVerified(report)
      && delivery?.render === renderPath
      && isFileFingerprintCurrent(renderFile, delivery?.renderFingerprint),
    );
    return { valid, trust: "strong", quality: valid ? "pass" : null };
  }

  return { valid: false, trust: "weak", quality: null };
}

function fingerprintMatches(step, episodeDir, snapshot) {
  if (!snapshot) return false;
  return snapshot.inputFingerprint === workflowInputFingerprint(episodeDir, step)
    && snapshot.outputFingerprint === workflowOutputFingerprint(episodeDir, step);
}

function usableStep(step, episodeDir, value) {
  if (value.status === "valid") return fingerprintMatches(step, episodeDir, value);
  return fingerprintMatches(step, episodeDir, value.lastValid);
}

function validStepFromArtifacts(previous, assessment, inputFingerprint, outputFingerprint, now) {
  return {
    ...previous,
    status: "valid",
    quality: assessment.quality,
    inputFingerprint,
    outputFingerprint,
    completedAt: previous.completedAt || now,
    updatedAt: now,
    diagnostic: null,
  };
}

function dependenciesForStep(episodeDir, step, override) {
  if (override) return override;
  if (step === "timed") {
    const timings = readJson(path.join(episodeDir, "audio", "body-timings.json"));
    const defaultVoice = path.join(episodeDir, "audio", "body-voiceover.mp3");
    if (timings?.audio && path.resolve(timingAudioPath(episodeDir, timings)) !== path.resolve(defaultVoice)) {
      return ["script_approved"];
    }
  }
  return WORKFLOW_DEPENDENCIES[step];
}

function refreshDependencyStatuses(episodeDir, steps, now) {
  const nextSteps = { ...steps };
  for (const step of WORKFLOW_STEPS) {
    const dependencies = dependenciesForStep(episodeDir, step);
    if (dependencies.length === 0) continue;
    const dependenciesReady = dependencies.every(
      (dependency) => usableStep(dependency, episodeDir, nextSteps[dependency]),
    );
    if (!dependenciesReady && nextSteps[step].status === "valid") {
      nextSteps[step] = {
        ...nextSteps[step],
        status: "stale",
        updatedAt: now,
      };
    }
  }
  for (const step of WORKFLOW_STEPS) {
    const value = nextSteps[step];
    if (!["pending", "ready"].includes(value.status)) continue;
    const dependenciesReady = dependenciesForStep(episodeDir, step).every(
      (dependency) => usableStep(dependency, episodeDir, nextSteps[dependency]),
    );
    nextSteps[step] = {
      ...value,
      status: dependenciesReady ? "ready" : "pending",
      updatedAt: value.updatedAt || now,
    };
  }
  return nextSteps;
}

export function reconcileWorkflowState(episodeDir, { now = new Date().toISOString(), write = true } = {}) {
  const state = readStateForReconcile(episodeDir);
  const steps = {};

  for (const step of WORKFLOW_STEPS) {
    const previous = { ...createStep(), ...state.steps[step] };
    const assessment = assessArtifacts(episodeDir, step);
    const inputFingerprint = workflowInputFingerprint(episodeDir, step);
    const outputFingerprint = workflowOutputFingerprint(episodeDir, step);
    const currentSnapshotMatches =
      previous.inputFingerprint === inputFingerprint
      && previous.outputFingerprint === outputFingerprint;
    const lastValidMatches = fingerprintMatches(step, episodeDir, previous.lastValid);
    let next = { ...previous };

    const runningSince = Date.parse(previous.startedAt || "");
    if (
      step === "timed"
      && previous.status === "needs_attention"
      && previous.diagnostic?.code === "voiceover_script_alignment_failed"
    ) {
      // Migrate the obsolete Whisper hard-gate state. Current timing uses
      // silence boundaries; ASR mismatch is review evidence, not a blocker.
      next = assessment.valid
        ? validStepFromArtifacts(previous, assessment, inputFingerprint, outputFingerprint, now)
        : { ...previous, status: "stale", diagnostic: null, updatedAt: now };
    } else if (
      previous.status === "running"
      && Number.isFinite(runningSince)
      && Date.parse(now) - runningSince > RUNNING_TIMEOUT_MS
    ) {
      next = {
        ...next,
        status: "needs_attention",
        diagnostic: {
          code: "interrupted_step",
          error: `The ${step} step did not finish within the recovery window`,
          recoverable: true,
          nextActions: ["Inspect the prior command output, then retry the same step."],
          recordedAt: now,
        },
        updatedAt: now,
      };
    } else if (previous.status === "valid" && !currentSnapshotMatches) {
      next = assessment.valid && (
        assessment.trust === "strong"
        || (
          outputFingerprint !== previous.outputFingerprint
          && inputFingerprint === previous.inputFingerprint
        )
      )
        ? validStepFromArtifacts(previous, assessment, inputFingerprint, outputFingerprint, now)
        : {
            ...next,
            status: "stale",
            updatedAt: now,
          };
    } else if (
      assessment.valid
      && assessment.trust === "strong"
      && !["running", "needs_attention"].includes(previous.status)
    ) {
      next = validStepFromArtifacts(previous, assessment, inputFingerprint, outputFingerprint, now);
    } else if (
      assessment.valid
      && assessment.trust === "strong"
      && previous.status === "needs_attention"
      && !lastValidMatches
    ) {
      next = validStepFromArtifacts(previous, assessment, inputFingerprint, outputFingerprint, now);
    } else if (
      assessment.valid
      && assessment.trust === "weak"
      && (
        ["pending", "ready"].includes(previous.status)
        || (previous.status === "stale" && outputFingerprint !== previous.outputFingerprint)
        || (previous.status === "needs_attention" && !lastValidMatches)
      )
    ) {
      next = validStepFromArtifacts(previous, assessment, inputFingerprint, outputFingerprint, now);
    } else if (
      previous.status === "valid"
      && !assessment.valid
    ) {
      next = {
        ...next,
        status: "stale",
        updatedAt: now,
      };
    }

    steps[step] = next;
  }

  const nextState = {
    ...state,
    steps: refreshDependencyStatuses(episodeDir, steps, now),
    updatedAt: now,
    reconciledAt: now,
  };
  if (write) writeWorkflowState(episodeDir, nextState);
  return nextState;
}

function validSnapshot(value) {
  return {
    quality: value.quality,
    inputFingerprint: value.inputFingerprint,
    outputFingerprint: value.outputFingerprint,
    completedAt: value.completedAt,
  };
}

export function beginWorkflowStep(
  episodeDir,
  step,
  { dependencies, enforceDependencies = false, now = new Date().toISOString() } = {},
) {
  if (!WORKFLOW_STEPS.includes(step)) throw new Error(`Unknown workflow step: ${step}`);
  if (step === "rendered") assertRenderTimingPreflight(episodeDir);
  const state = reconcileWorkflowState(episodeDir, { now, write: false });
  if (enforceDependencies) {
    const missing = dependenciesForStep(episodeDir, step, dependencies).filter(
      (dependency) => !usableStep(dependency, episodeDir, state.steps[dependency]),
    );
    if (missing.length) {
      const error = new Error(`${step} requires valid steps: ${missing.join(", ")}`);
      error.code = "workflow_dependency_missing";
      error.recoverable = true;
      error.nextActions = [`Complete or repair: ${missing.join(", ")}.`, `Retry ${step}.`];
      throw error;
    }
  }
  const current = state.steps[step];
  const lastValid = current.status === "valid" ? validSnapshot(current) : current.lastValid;
  state.steps[step] = {
    ...current,
    status: "running",
    attempts: current.attempts + 1,
    startedAt: now,
    updatedAt: now,
    diagnostic: null,
    lastValid,
  };
  state.updatedAt = now;
  writeWorkflowState(episodeDir, state);
  return state;
}

export function completeWorkflowStep(
  episodeDir,
  step,
  { dependencies, quality = "", enforceDependencies = false, now = new Date().toISOString() } = {},
) {
  if (!WORKFLOW_STEPS.includes(step)) throw new Error(`Unknown workflow step: ${step}`);
  const state = reconcileWorkflowState(episodeDir, { now, write: false });
  if (enforceDependencies) {
    const missing = dependenciesForStep(episodeDir, step, dependencies).filter(
      (dependency) => !usableStep(dependency, episodeDir, state.steps[dependency]),
    );
    if (missing.length) {
      const error = new Error(`${step} requires valid steps: ${missing.join(", ")}`);
      error.code = "workflow_dependency_missing";
      error.recoverable = true;
      error.nextActions = [`Complete or repair: ${missing.join(", ")}.`, `Retry ${step}.`];
      throw error;
    }
  }
  if (step === "script_approved") {
    const scriptPath = path.join(episodeDir, "script.csv");
    writeJsonAtomic(path.join(episodeDir, "script-approval.json"), {
      schemaVersion: 1,
      scriptVersion: activeScriptVersion(episodeDir),
      scriptFingerprint: fingerprintFile(scriptPath),
      approvedAt: now,
    });
  }
  if (step === "delivered") {
    const report = readReport(episodeDir);
    const renderPath = renderRelativePath(episodeDir);
    const renderFile = renderPath ? path.join(episodeDir, renderPath) : "";
    if (!reportVerified(report) || !renderFile || !fs.existsSync(renderFile)) {
      throw new Error("Verified render is required before delivery");
    }
    writeJsonAtomic(path.join(episodeDir, "delivery.json"), {
      schemaVersion: 1,
      render: renderPath,
      renderFingerprint: fingerprintFile(renderFile),
      deliveredAt: now,
    });
  }
  const assessment = assessArtifacts(episodeDir, step);
  if (!assessment.valid) {
    throw new Error(`Artifacts for ${step} are missing or invalid`);
  }
  const current = state.steps[step];
  state.steps[step] = {
    ...current,
    status: "valid",
    quality: quality || assessment.quality || "pass",
    inputFingerprint: workflowInputFingerprint(episodeDir, step),
    outputFingerprint: workflowOutputFingerprint(episodeDir, step),
    startedAt: null,
    completedAt: now,
    updatedAt: now,
    diagnostic: null,
  };
  state.steps = refreshDependencyStatuses(episodeDir, state.steps, now);
  state.updatedAt = now;
  state.reconciledAt = now;
  writeWorkflowState(episodeDir, state);
  return state;
}

export function revalidateWorkflowStep(
  episodeDir,
  step,
  { evidence, now = new Date().toISOString() } = {},
) {
  if (!["illustrated", "voiced"].includes(step)) {
    throw new Error(`Only weak-trust steps can be revalidated: ${step}`);
  }
  const reviewEvidence = typeof evidence === "string" ? evidence.trim() : "";

  const state = reconcileWorkflowState(episodeDir, { now, write: false });
  const current = state.steps[step];
  if (current.status !== "stale") {
    const error = new Error(`${step} must be stale before it can be revalidated`);
    error.code = "workflow_step_not_stale";
    throw error;
  }
  const missingDependencies = ["script_validated", "script_approved"].filter(
    (dependency) => !usableStep(dependency, episodeDir, state.steps[dependency]),
  );
  if (missingDependencies.length > 0) {
    const error = new Error(`${step} requires a current validated and approved script`);
    error.code = "workflow_dependency_missing";
    error.nextActions = [`Complete or repair: ${missingDependencies.join(", ")}.`, "Retry revalidation."];
    throw error;
  }

  const scriptVersion = activeScriptVersion(episodeDir);
  const scriptRows = readCsv(path.join(episodeDir, "script.csv")).rows
    .filter((row) => row.version === scriptVersion)
    .sort((left, right) => Number(left.order) - Number(right.order));
  const illustrationImageCount = requiredImageNames(episodeDir).length;
  const checkedCount = step === "voiced" ? scriptRows.length : illustrationImageCount;
  const expectedEvidence = step === "voiced"
    ? `voiced@${scriptVersion}:逐句核听 ${checkedCount}/${checkedCount} 行，并确认全部与当前稿逐行一致`
    : `illustrated@${scriptVersion}:逐张检查 ${checkedCount}/${checkedCount} 张图片，并确认每张均适配当前稿`;
  if (reviewEvidence !== expectedEvidence) {
    const error = new Error(`Evidence does not match the ${step} review for script ${scriptVersion}; expected: ${expectedEvidence}`);
    error.code = "workflow_review_evidence_invalid";
    throw error;
  }

  const assessment = assessArtifacts(episodeDir, step);
  if (!assessment.valid) {
    const error = new Error(`Required outputs for ${step} are missing or invalid`);
    error.code = "workflow_artifact_invalid";
    throw error;
  }

  state.steps[step] = {
    ...current,
    status: "valid",
    quality: assessment.quality || "review_required",
    inputFingerprint: workflowInputFingerprint(episodeDir, step),
    outputFingerprint: workflowOutputFingerprint(episodeDir, step),
    startedAt: null,
    completedAt: now,
    updatedAt: now,
    diagnostic: null,
    revalidation: {
      step,
      reviewedAt: now,
      scriptVersion,
      checkedCount,
      expectedCount: checkedCount,
      evidence: reviewEvidence,
    },
  };
  state.steps = refreshDependencyStatuses(episodeDir, state.steps, now);
  state.updatedAt = now;
  state.reconciledAt = now;
  writeWorkflowState(episodeDir, state);
  return state;
}

export function failWorkflowStep(
  episodeDir,
  step,
  diagnostic,
  { now = new Date().toISOString() } = {},
) {
  if (!episodeDir || !WORKFLOW_STEPS.includes(step)) return null;
  const state = reconcileWorkflowState(episodeDir, { now, write: false });
  const current = state.steps[step];
  if (diagnostic?.code === "workflow_render_preflight_blocked") return state;
  if (diagnostic?.code === "workflow_dependency_missing") {
    if (current.status !== "running") return state;
    const restored = fingerprintMatches(step, episodeDir, current.lastValid);
    state.steps[step] = restored
      ? {
          ...current,
          ...current.lastValid,
          status: "valid",
          startedAt: null,
          updatedAt: now,
          diagnostic: null,
        }
      : {
          ...current,
          status: current.lastValid ? "stale" : "pending",
          startedAt: null,
          updatedAt: now,
          diagnostic: null,
        };
    state.steps = refreshDependencyStatuses(episodeDir, state.steps, now);
    state.updatedAt = now;
    writeWorkflowState(episodeDir, state);
    return state;
  }
  const lastValid = current.status === "valid" ? validSnapshot(current) : current.lastValid;
  state.steps[step] = {
    ...current,
    status: "needs_attention",
    startedAt: null,
    updatedAt: now,
    diagnostic,
    lastValid,
  };
  state.updatedAt = now;
  writeWorkflowState(episodeDir, state);
  return state;
}

export function workflowNextActions(episodeDir, state = reconcileWorkflowState(episodeDir)) {
  const timingAlignmentFailure = renderTimingBlocker(episodeDir);
  const attention = WORKFLOW_STEPS
    .filter((step) => state.steps[step].status === "needs_attention")
    .map((step) => ({
      step,
      action: "diagnose_and_retry",
      activeArtifactValid: fingerprintMatches(step, episodeDir, state.steps[step].lastValid),
      diagnostic: state.steps[step].diagnostic,
    }));
  const ready = WORKFLOW_STEPS
    .filter((step) => state.steps[step].status === "ready")
    .filter((step) => !(step === "rendered" && timingAlignmentFailure))
    .map((step) => ({ step, action: step === "script_approved" ? "approve" : "run" }));
  const staleApproval = state.steps.script_approved.status === "stale"
    && usableStep("script_validated", episodeDir, state.steps.script_validated)
    ? [{ step: "script_approved", action: "approve" }]
    : [];
  const staleVoice = state.steps.voiced.status === "stale"
    && dependenciesForStep(episodeDir, "voiced").every(
      (dependency) => usableStep(dependency, episodeDir, state.steps[dependency]),
    )
    ? [{ step: "voiced", action: "run" }]
    : [];
  const staleTiming = state.steps.timed.status === "stale"
    && dependenciesForStep(episodeDir, "timed").every(
      (dependency) => usableStep(dependency, episodeDir, state.steps[dependency]),
    )
    ? [{ step: "timed", action: "run" }]
    : [];
  const verified = usableStep("verified", episodeDir, state.steps.verified);
  const rendered = usableStep("rendered", episodeDir, state.steps.rendered);
  const reviewSteps = verified
    ? []
    : rendered
      ? ["rendered"]
      : WORKFLOW_STEPS.filter((step) => ["review_required", "degraded"].includes(state.steps[step].quality));
  const review = reviewSteps
    .filter((step) => state.steps[step].status === "valid")
    .map((step) => ({ step, action: "review" }));
  const blocked = timingAlignmentFailure
    ? [{ step: "rendered", action: "blocked", blockedBy: "timed", diagnostic: timingAlignmentFailure }]
    : [];
  return [...attention, ...review, ...ready, ...staleApproval, ...staleVoice, ...staleTiming, ...blocked];
}

export function workflowSummary(episodeDir, state = reconcileWorkflowState(episodeDir)) {
  const timingAlignmentFailure = renderTimingBlocker(episodeDir);
  return {
    schemaVersion: state.schemaVersion,
    episode: state.episode,
    steps: Object.fromEntries(
      WORKFLOW_STEPS.map((step) => {
        const value = state.steps[step];
        return [step, {
          status: step === "rendered" && timingAlignmentFailure ? "blocked" : value.status,
          quality: value.quality,
          attempts: value.attempts,
          revalidation: value.revalidation,
          activeArtifactValid:
            value.status === "valid"
            ? fingerprintMatches(step, episodeDir, value)
            : fingerprintMatches(step, episodeDir, value.lastValid),
          error: value.diagnostic?.error || null,
        }];
      }),
    ),
    nextActions: workflowNextActions(episodeDir, state),
    reconciledAt: state.reconciledAt,
  };
}
