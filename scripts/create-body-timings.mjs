#!/usr/bin/env node

// Body timing generation from FFmpeg silencedetect speech boundaries only.
// Each speech segment maps to one script row in order. A single extra leading
// segment (a spoken opener such as "今天分享的是") is skipped for compatibility;
// anything else is coalesced or estimated and marked for review.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildCaptionTimings,
  buildEstimatedCaptionTimings,
  buildSpeechSegments,
  coalesceSpeechSegments,
  parseSilenceEvents,
} from "./lib/body-timings.mjs";
import { readCsv } from "./lib/csv.mjs";
import { fingerprintFile, isFileFingerprintCurrent, validateVoiceoverArtifact } from "./lib/media-validation.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";
import { beginWorkflowStep, completeWorkflowStep } from "./lib/workflow-state.mjs";

const ROOT = process.cwd();
const [episodeName, ...rawArgs] = process.argv.slice(2);
const episodeDir = episodeName ? path.join(ROOT, "episodes", episodeName) : "";

function readOptions(values) {
  const positional = [];
  const options = { noise: "-35dB", silenceDuration: "0.18", voiceoverNotBefore: "" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--noise" || value === "--silence-duration" || value === "--voiceover-not-before") {
      if (index + 1 >= values.length || values[index + 1] === "") {
        throw new WorkflowError(`${value} requires a value`, { code: "invalid_arguments" });
      }
      options[{
        "--noise": "noise",
        "--silence-duration": "silenceDuration",
        "--voiceover-not-before": "voiceoverNotBefore",
      }[value]] = values[++index];
    } else if (value.startsWith("--noise=")) options.noise = value.slice("--noise=".length);
    else if (value.startsWith("--silence-duration=")) options.silenceDuration = value.slice("--silence-duration=".length);
    else if (value.startsWith("--voiceover-not-before=")) {
      options.voiceoverNotBefore = value.slice("--voiceover-not-before=".length);
      if (!options.voiceoverNotBefore) {
        throw new WorkflowError("--voiceover-not-before requires a value", { code: "invalid_arguments" });
      }
    }
    else positional.push(value);
  }
  return { positional, options };
}

function readScriptRows(filePath, version) {
  return readCsv(filePath).rows
    .filter((row) => row.version === version)
    .sort((a, b) => Number(a.order) - Number(b.order));
}

function readEpisodeTitle(directory, fallback) {
  try {
    const brief = JSON.parse(fs.readFileSync(path.join(directory, "brief.json"), "utf8"));
    return String(brief.display_title || brief.displayTitle || brief.title || fallback);
  } catch {
    return fallback;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", shell: false, ...options });
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout || `status=${result.status}, signal=${result.signal || "none"}`;
    throw new Error(`${command} failed: ${detail.trim()}`);
  }
  return result;
}

function usage() {
  console.error("Usage: node scripts/create-body-timings.mjs <episode-name> [script-version] [voiceover-path] [options]");
  console.error("Options: --noise -35dB --silence-duration 0.18 --voiceover-not-before <ISO>");
}

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/create-body-timings.mjs",
  stage: "voiceover_timing",
  episodeDir,
  workflowStep: "timed",
  nextActions: [
    "Inspect the episode, active script version, and voiceover path named in the error.",
    "Repair or replace only the failing input, then rerun timing generation.",
    "If pause detection fails, retain the generated duration-based fallback and require Agent review.",
  ],
});

if (!episodeName) {
  usage();
  throw new WorkflowError("Usage: node scripts/create-body-timings.mjs <episode-name> [script-version] [voiceover-path] [options]", {
    code: "invalid_arguments",
  });
}

let requestedVersion = "";
if (rawArgs[0] && !rawArgs[0].startsWith("--")) requestedVersion = rawArgs.shift();
const { positional, options } = readOptions(rawArgs);
if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
const scriptVersion = resolveScriptVersion(episodeDir, requestedVersion);
const audioDir = path.join(episodeDir, "audio");
const scriptPath = path.join(episodeDir, "script.csv");
const defaultVoicePath = path.join(episodeDir, "audio", "body-voiceover.mp3");
const voicePath = path.resolve(ROOT, positional[0] || defaultVoicePath);
const workflowDependencies = voicePath === path.resolve(defaultVoicePath) ? undefined : ["script_approved"];
const timingsPath = path.join(audioDir, "body-timings.json");
beginWorkflowStep(episodeDir, "timed", {
  dependencies: workflowDependencies,
  enforceDependencies: true,
});

if (!fs.existsSync(scriptPath)) throw new Error(`Missing script.csv: ${scriptPath}`);
const scriptFingerprint = fingerprintFile(scriptPath);
const voiceover = validateVoiceoverArtifact(voicePath, { notBefore: options.voiceoverNotBefore });

const rows = readScriptRows(scriptPath, scriptVersion);
if (!rows.length) throw new Error(`No script rows found for version ${scriptVersion}`);
const displayTitle = readEpisodeTitle(episodeDir, episodeName);
const scriptValidation = validateBodyScript(rows, { episodeTitle: displayTitle });
if (scriptValidation.errors.length) throw new Error(scriptValidation.errors.join("；"));

const duration = voiceover.duration;
let speechSegments;
let silenceFailure = null;
try {
  const silenceResult = run(
    "ffmpeg",
    ["-hide_banner", "-i", voicePath, "-af", `silencedetect=noise=${options.noise}:d=${options.silenceDuration}`, "-f", "null", "-"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const events = parseSilenceEvents(`${silenceResult.stdout}\n${silenceResult.stderr}`);
  speechSegments = buildSpeechSegments(duration, events);
} catch (error) {
  silenceFailure = error;
  speechSegments = [{ start: 0, end: duration }];
  console.warn(`Silence detection unavailable; continuing with full audio duration: ${error.message}`);
}

// Do not infer that an extra segment is an opener from its count. Reconcile
// every count mismatch below by merging nearby boundaries or estimating from
// the detected speech duration, then flag the result for review.
const mappedSegments = speechSegments;

let captions;
let fallbackReason = null;
let method = "silence-boundary";
let requiresAgentReview = Boolean(silenceFailure);
try {
  const normalizedSegments = mappedSegments.length === rows.length
    ? mappedSegments
    : coalesceSpeechSegments(mappedSegments, rows.length);
  captions = buildCaptionTimings(rows.map((row) => row.order), normalizedSegments);
  if (mappedSegments.length !== rows.length) {
    requiresAgentReview = true;
    fallbackReason = `Found ${speechSegments.length} speech segments for ${rows.length} script rows; merged the shortest adjacent gaps to match.`;
    console.warn(`[timing] ${fallbackReason}`);
  }
} catch (error) {
  captions = buildEstimatedCaptionTimings(rows, mappedSegments, duration);
  method = "speech-duration-estimate";
  fallbackReason = error.message;
  requiresAgentReview = true;
  console.warn(`[timing] Speech pauses were insufficient; continuing with duration estimate: ${error.message}`);
}

if (!isFileFingerprintCurrent(scriptPath, scriptFingerprint)) {
  throw new WorkflowError("script.csv changed during timing generation; refusing to save timings for a different script snapshot.", {
    code: "script_changed_during_timing",
    details: { scriptVersion, script: path.relative(ROOT, scriptPath) },
    nextActions: ["Review the current approved script, then rerun timing generation."],
  });
}

const alignment = {
  method,
  speechSegments: speechSegments.length,
  silenceDetectionAvailable: !silenceFailure,
  requiresAgentReview,
  fallbackReason,
};
const timings = {
  scriptVersion,
  duration: Number(duration.toFixed(2)),
  source: `script.csv subtitle truth with ${alignment.method}`,
  audio: path.relative(ROOT, voicePath),
  audioFingerprint: voiceover.fingerprint,
  scriptFingerprint,
  silence: { noise: options.noise, duration: Number(options.silenceDuration) },
  alignment,
  captions,
};
const temporaryTimingsPath = `${timingsPath}.${process.pid}.tmp`;
const previousTimingsPath = `${timingsPath}.${process.pid}.previous`;
fs.writeFileSync(temporaryTimingsPath, `${JSON.stringify(timings, null, 2)}\n`, { mode: 0o600 });
if (fs.existsSync(timingsPath)) fs.renameSync(timingsPath, previousTimingsPath);
try {
  fs.renameSync(temporaryTimingsPath, timingsPath);
  completeWorkflowStep(episodeDir, "timed", {
    dependencies: workflowDependencies,
    enforceDependencies: true,
    quality: requiresAgentReview ? "degraded" : "pass",
  });
  fs.rmSync(previousTimingsPath, { force: true });
} catch (error) {
  fs.rmSync(timingsPath, { force: true });
  if (fs.existsSync(previousTimingsPath)) fs.renameSync(previousTimingsPath, timingsPath);
  throw error;
} finally {
  fs.rmSync(temporaryTimingsPath, { force: true });
  if (fs.existsSync(previousTimingsPath) && !fs.existsSync(timingsPath)) {
    fs.renameSync(previousTimingsPath, timingsPath);
  }
  fs.rmSync(previousTimingsPath, { force: true });
}

console.log(`Body timings (${alignment.method}): ${path.relative(ROOT, timingsPath)}`);
