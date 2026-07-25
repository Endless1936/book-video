import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readCsv } from "./csv.mjs";
import { fingerprintFile, isFileFingerprintCurrent } from "./media-validation.mjs";
import { resolveScriptVersion } from "./script-version.mjs";
import { validateBodyScript } from "./script-policy.mjs";

export const WORKFLOW_STEPS = Object.freeze([
  "selected",
  "researched",
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
  selected: [],
  researched: ["selected"],
  script_validated: ["researched"],
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
const REQUIRED_IMAGES = [
  "result-bridge.png",
  "atmosphere-1.png",
  "atmosphere-2.png",
  "atmosphere-3.png",
];

function createStep() {
  return {
    status: "pending",
    quality: null,
    attempts: 0,
    inputFingerprint: null,
    outputFingerprint: null,
    activeArtifactValid: false,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    diagnostic: null,
    lastValid: null,
    inferred: false,
  };
}

export function createWorkflowState(episodeDir, now = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    episode: path.basename(episodeDir),
    steps: Object.fromEntries(WORKFLOW_STEPS.map((step) => [step, createStep()])),
    createdAt: now,
    updatedAt: now,
    reconciledAt: null,
  };
}

function normalizeState(state, episodeDir) {
  if (!state || state.schemaVersion !== 1 || typeof state.steps !== "object") {
    throw new Error("Unsupported or malformed workflow state");
  }
  return {
    ...createWorkflowState(episodeDir, state.createdAt),
    ...state,
    episode: path.basename(episodeDir),
    steps: Object.fromEntries(
      WORKFLOW_STEPS.map((step) => [step, { ...createStep(), ...(state.steps[step] || {}) }]),
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

function inputTargets(episodeDir, step) {
  const report = readReport(episodeDir);
  const repositoryRoot = path.resolve(episodeDir, "..", "..");
  const bgm = report?.inputArtifacts?.bgm?.path
    ? path.resolve(repositoryRoot, report.inputArtifacts.bgm.path)
    : report?.bgm ? path.join("..", "..", "assets", "bgm", report.bgm) : "";
  const targets = {
    selected: [],
    researched: ["brief.json"],
    script_validated: ["brief.json", "script.csv"],
    script_approved: ["script.csv"],
    illustrated: ["script.csv", "prompts.csv"],
    voiced: ["script.csv"],
    timed: ["script.csv", path.join("audio", "body-voiceover.mp3")],
    rendered: [
      "script.csv",
      "prompts.csv",
      "images",
      path.join("audio", "body-voiceover.mp3"),
      path.join("audio", "body-timings.json"),
      path.join("..", "..", "templates", "shared-video-template"),
      path.join("..", "..", "assets", "template-audio"),
      path.join("..", "..", "assets", "sfx", "gear-scroll.mp3"),
      bgm,
    ].filter(Boolean),
    verified: [renderRelativePath(episodeDir), "production-report.json"].filter(Boolean),
    delivered: [renderRelativePath(episodeDir), "production-report.json"].filter(Boolean),
  };
  return targets[step] || [];
}

function outputTargets(episodeDir, step) {
  const targets = {
    selected: ["brief.json"],
    researched: ["brief.json"],
    script_validated: ["script.csv"],
    script_approved: ["script-approval.json"],
    illustrated: ["prompts.csv", ...REQUIRED_IMAGES.map((name) => path.join("images", name))],
    voiced: [path.join("audio", "body-voiceover.mp3")],
    timed: [path.join("audio", "body-timings.json")],
    rendered: [renderRelativePath(episodeDir)].filter(Boolean),
    verified: ["production-report.json"],
    delivered: ["delivery.json"],
  };
  return targets[step] || [];
}

export function workflowInputFingerprint(episodeDir, step) {
  return fingerprintBundle(episodeDir, inputTargets(episodeDir, step));
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
  const renderPath = renderRelativePath(episodeDir);
  const renderFile = renderPath ? path.join(episodeDir, renderPath) : "";
  const scriptPath = path.join(episodeDir, "script.csv");
  const scriptApproval = readJson(path.join(episodeDir, "script-approval.json"));
  const delivery = readJson(path.join(episodeDir, "delivery.json"));

  if (step === "selected") {
    const valid = Boolean(
      brief
      && String(brief.display_title || brief.displayTitle || brief.title || "").trim()
      && String(brief.author || "").trim(),
    );
    return { valid, trust: "strong", quality: "pass" };
  }

  if (step === "researched") {
    const valid = Boolean(
      brief
      && String(brief.source_channel || brief.source || brief.provenance || "").trim()
      && String(brief.edition_status || brief.edition || brief.version_status || "").trim(),
    );
    return { valid, trust: "strong", quality: "pass" };
  }

  if (step === "script_validated") {
    if (!fs.existsSync(scriptPath) || !version) return { valid: false, trust: "strong", quality: null };
    try {
      const rows = readCsv(scriptPath).rows
        .filter((row) => row.version === version)
        .sort((left, right) => Number(left.order) - Number(right.order));
      const valid = rows.length > 0 && validateBodyScript(rows).errors.length === 0;
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
    const valid = REQUIRED_IMAGES.every((name) => {
      const filePath = path.join(episodeDir, "images", name);
      return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    });
    return { valid, trust: "weak", quality: "review_required" };
  }

  if (step === "voiced") {
    const valid = fs.existsSync(voicePath) && fs.statSync(voicePath).size >= 1024;
    return { valid, trust: "weak", quality: "review_required" };
  }

  if (step === "timed") {
    const valid = Boolean(
      timings
      && timings.scriptVersion === version
      && isFileFingerprintCurrent(voicePath, timings.audioFingerprint)
      && Array.isArray(timings.captions)
      && timings.captions.length > 0,
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
      && fs.existsSync(renderFile)
      && fs.statSync(renderFile).size > 0,
    );
    return { valid, trust: "weak", quality: valid ? "review_required" : null };
  }

  if (step === "verified") {
    const valid = Boolean(report?.verified === true && report?.agentReview?.status !== "pending");
    return { valid, trust: "strong", quality: valid ? "pass" : null };
  }

  if (step === "delivered") {
    const valid = Boolean(
      delivery
      && delivery.output === renderPath
      && isFileFingerprintCurrent(renderFile, delivery.renderFingerprint),
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

function inferredValidStep(previous, assessment, inputFingerprint, outputFingerprint, now) {
  return {
    ...previous,
    status: "valid",
    quality: assessment.quality,
    inputFingerprint,
    outputFingerprint,
    activeArtifactValid: true,
    completedAt: previous.completedAt || now,
    updatedAt: now,
    diagnostic: null,
    inferred: true,
  };
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
    let next = {
      ...previous,
      activeArtifactValid: currentSnapshotMatches || lastValidMatches,
    };

    const runningSince = Date.parse(previous.startedAt || "");
    if (
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
      next = {
        ...next,
        status: "stale",
        activeArtifactValid: false,
        updatedAt: now,
      };
    } else if (
      assessment.valid
      && assessment.trust === "strong"
      && !["running", "needs_attention"].includes(previous.status)
    ) {
      next = inferredValidStep(previous, assessment, inputFingerprint, outputFingerprint, now);
    } else if (
      assessment.valid
      && assessment.trust === "strong"
      && previous.status === "needs_attention"
      && !lastValidMatches
    ) {
      next = inferredValidStep(previous, assessment, inputFingerprint, outputFingerprint, now);
    } else if (
      assessment.valid
      && assessment.trust === "weak"
      && ["pending", "ready"].includes(previous.status)
    ) {
      next = inferredValidStep(previous, assessment, inputFingerprint, outputFingerprint, now);
    } else if (
      previous.status === "valid"
      && !assessment.valid
      && step !== "script_approved"
      && step !== "delivered"
    ) {
      next = {
        ...next,
        status: "stale",
        activeArtifactValid: false,
        updatedAt: now,
      };
    }

    steps[step] = next;
  }

  for (const step of WORKFLOW_STEPS) {
    if (WORKFLOW_DEPENDENCIES[step].length === 0) continue;
    const dependenciesReady = WORKFLOW_DEPENDENCIES[step].every(
      (dependency) => usableStep(dependency, episodeDir, steps[dependency]),
    );
    if (dependenciesReady) continue;
    const value = steps[step];
    if (value.status === "valid") {
      steps[step] = {
        ...value,
        status: "stale",
        activeArtifactValid: false,
        updatedAt: now,
      };
    } else if (value.status === "needs_attention" && value.activeArtifactValid) {
      steps[step] = {
        ...value,
        activeArtifactValid: false,
        updatedAt: now,
      };
    }
  }

  for (const step of WORKFLOW_STEPS) {
    const value = steps[step];
    if (!["pending", "ready"].includes(value.status)) continue;
    const dependenciesReady = WORKFLOW_DEPENDENCIES[step].every(
      (dependency) => usableStep(dependency, episodeDir, steps[dependency]),
    );
    steps[step] = {
      ...value,
      status: dependenciesReady ? "ready" : "pending",
      updatedAt: value.updatedAt || now,
    };
  }

  const nextState = {
    ...state,
    steps,
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

export function beginWorkflowStep(episodeDir, step, { now = new Date().toISOString() } = {}) {
  if (!WORKFLOW_STEPS.includes(step)) throw new Error(`Unknown workflow step: ${step}`);
  const state = reconcileWorkflowState(episodeDir, { now });
  const current = state.steps[step];
  const lastValid = current.status === "valid" ? validSnapshot(current) : current.lastValid;
  state.steps[step] = {
    ...current,
    status: "running",
    attempts: current.attempts + 1,
    activeArtifactValid: Boolean(lastValid && fingerprintMatches(step, episodeDir, lastValid)),
    startedAt: now,
    updatedAt: now,
    diagnostic: null,
    lastValid,
    inferred: false,
  };
  state.updatedAt = now;
  writeWorkflowState(episodeDir, state);
  return state;
}

export function completeWorkflowStep(
  episodeDir,
  step,
  { quality = "", details = {}, enforceDependencies = false, now = new Date().toISOString() } = {},
) {
  if (!WORKFLOW_STEPS.includes(step)) throw new Error(`Unknown workflow step: ${step}`);
  const state = reconcileWorkflowState(episodeDir, { now });
  if (enforceDependencies) {
    const missing = WORKFLOW_DEPENDENCIES[step].filter(
      (dependency) => !usableStep(dependency, episodeDir, state.steps[dependency]),
    );
    if (missing.length) throw new Error(`${step} requires valid steps: ${missing.join(", ")}`);
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
    const output = renderRelativePath(episodeDir);
    const renderFile = path.join(episodeDir, output);
    writeJsonAtomic(path.join(episodeDir, "delivery.json"), {
      schemaVersion: 1,
      output,
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
    ...details,
    status: "valid",
    quality: quality || assessment.quality || "pass",
    inputFingerprint: workflowInputFingerprint(episodeDir, step),
    outputFingerprint: workflowOutputFingerprint(episodeDir, step),
    activeArtifactValid: true,
    startedAt: null,
    completedAt: now,
    updatedAt: now,
    diagnostic: null,
    inferred: false,
  };
  state.updatedAt = now;
  writeWorkflowState(episodeDir, state);
  return reconcileWorkflowState(episodeDir, { now });
}

export function failWorkflowStep(
  episodeDir,
  step,
  diagnostic,
  { now = new Date().toISOString() } = {},
) {
  if (!episodeDir || !WORKFLOW_STEPS.includes(step)) return null;
  const state = reconcileWorkflowState(episodeDir, { now });
  const current = state.steps[step];
  const lastValid = current.status === "valid" ? validSnapshot(current) : current.lastValid;
  state.steps[step] = {
    ...current,
    status: "needs_attention",
    activeArtifactValid: Boolean(lastValid && fingerprintMatches(step, episodeDir, lastValid)),
    startedAt: null,
    updatedAt: now,
    diagnostic,
    lastValid,
    inferred: false,
  };
  state.updatedAt = now;
  writeWorkflowState(episodeDir, state);
  return state;
}

export function workflowNextActions(episodeDir, state = reconcileWorkflowState(episodeDir)) {
  const attention = WORKFLOW_STEPS
    .filter((step) => state.steps[step].status === "needs_attention")
    .map((step) => ({
      step,
      action: "diagnose_and_retry",
      activeArtifactValid: state.steps[step].activeArtifactValid,
      diagnostic: state.steps[step].diagnostic,
    }));
  const ready = WORKFLOW_STEPS
    .filter((step) => state.steps[step].status === "ready")
    .map((step) => ({ step, action: "run" }));
  const review = WORKFLOW_STEPS
    .filter((step) => state.steps[step].status === "valid" && state.steps[step].quality === "review_required")
    .map((step) => ({ step, action: "review" }));
  return [...attention, ...ready, ...review];
}

export function workflowSummary(episodeDir) {
  const state = reconcileWorkflowState(episodeDir);
  return {
    schemaVersion: state.schemaVersion,
    episode: state.episode,
    steps: Object.fromEntries(
      WORKFLOW_STEPS.map((step) => {
        const value = state.steps[step];
        return [step, {
          status: value.status,
          quality: value.quality,
          attempts: value.attempts,
          activeArtifactValid: value.activeArtifactValid,
          error: value.diagnostic?.error || null,
        }];
      }),
    ),
    nextActions: workflowNextActions(episodeDir, state),
    reconciledAt: state.reconciledAt,
  };
}
