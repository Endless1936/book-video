#!/usr/bin/env node

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
import { validateVoiceoverArtifact } from "./lib/media-validation.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
const MODEL_PATH = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
const [episodeName, ...rawArgs] = process.argv.slice(2);

function readOptions(values) {
  const positional = [];
  const options = { skipLeading: 1, noise: "-35dB", silenceDuration: "0.18", voiceoverNotBefore: "" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--skip-leading" || value === "--noise" || value === "--silence-duration" || value === "--voiceover-not-before") {
      if (index + 1 >= values.length || values[index + 1] === "") {
        throw new WorkflowError(`${value} requires a value`, { code: "invalid_arguments" });
      }
      options[{
        "--skip-leading": "skipLeading",
        "--noise": "noise",
        "--silence-duration": "silenceDuration",
        "--voiceover-not-before": "voiceoverNotBefore",
      }[value]] = values[++index];
    } else if (value.startsWith("--skip-leading=")) options.skipLeading = value.slice("--skip-leading=".length);
    else if (value.startsWith("--noise=")) options.noise = value.slice("--noise=".length);
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
  console.error("Options: --skip-leading 1 --noise -35dB --silence-duration 0.18 --voiceover-not-before <ISO>");
}

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/create-body-timings.mjs",
  stage: "voiceover_timing",
  nextActions: [
    "Inspect the episode, active script version, and voiceover path named in the error.",
    "Repair or replace only the failing input, then rerun timing generation.",
    "If ASR or pause detection fails, retain the generated duration-based fallback and require Agent review.",
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
const episodeDir = path.join(ROOT, "episodes", episodeName);
const scriptVersion = resolveScriptVersion(episodeDir, requestedVersion);
const audioDir = path.join(episodeDir, "audio");
const scriptPath = path.join(episodeDir, "script.csv");
const voicePath = path.resolve(ROOT, positional[0] || path.join("episodes", episodeName, "audio", "body-voiceover.mp3"));
const asrDir = path.join(audioDir, "asr");
const asrBase = path.join(asrDir, "body");
const timingsPath = path.join(audioDir, "body-timings.json");

if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
if (!fs.existsSync(scriptPath)) throw new Error(`Missing script.csv: ${scriptPath}`);
const voiceover = validateVoiceoverArtifact(voicePath, { notBefore: options.voiceoverNotBefore });

const rows = readScriptRows(scriptPath, scriptVersion);
if (!rows.length) throw new Error(`No script rows found for version ${scriptVersion}`);
const scriptValidation = validateBodyScript(rows);
if (scriptValidation.errors.length) throw new Error(scriptValidation.errors.join("；"));

fs.mkdirSync(asrDir, { recursive: true });
const whisperPrompt = `${episodeName}。${rows.map((row) => row.text).join("。")}`;
let whisperFailure = null;
if (fs.existsSync(MODEL_PATH)) {
  try {
    run(
      "whisper-cli",
      ["-ng", "-m", MODEL_PATH, "-l", "zh", "-ojf", "-otxt", "--prompt", whisperPrompt, "-of", asrBase, voicePath],
      { stdio: "inherit" },
    );
  } catch (error) {
    whisperFailure = error;
    console.warn(`Whisper unavailable; continuing without ASR text alignment: ${error.message}`);
  }
} else {
  whisperFailure = new Error(`Missing Whisper model: ${MODEL_PATH}`);
  console.warn(`${whisperFailure.message}; continuing without ASR text alignment`);
}

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
const skipLeading = Number(options.skipLeading) || 0;
let asr = { transcription: [] };
if (!whisperFailure) {
  try {
    asr = JSON.parse(fs.readFileSync(`${asrBase}.json`, "utf8"));
  } catch (error) {
    whisperFailure = error;
    console.warn(`Whisper output could not be read; continuing without ASR text alignment: ${error.message}`);
  }
}
let captions;
let alignment = {
  method: "silence-segments",
  speechSegments: speechSegments.length,
  requiresAgentReview: false,
};
try {
  const normalizedSegments = coalesceSpeechSegments(speechSegments, rows.length + skipLeading);
  captions = buildCaptionTimings(rows.map((row) => row.order), normalizedSegments, skipLeading);
} catch (error) {
  captions = buildEstimatedCaptionTimings(rows, speechSegments, duration, skipLeading);
  alignment = {
    method: "speech-duration-estimate",
    reason: error.message,
    speechSegments: speechSegments.length,
    silenceDetectionAvailable: !silenceFailure,
    requiresAgentReview: true,
  };
  console.warn(`Speech pauses were insufficient; continuing with duration estimate: ${error.message}`);
}
alignment.asrAvailable = !whisperFailure;
alignment.asrText = (asr.transcription || []).map((segment) => segment.text).join("");
const timings = {
    scriptVersion,
    duration: Number(duration.toFixed(2)),
    source: `script.csv subtitle truth with ${alignment.method}`,
    audio: path.relative(ROOT, voicePath),
    audioFingerprint: voiceover.fingerprint,
    asr: fs.existsSync(`${asrBase}.json`) ? path.relative(ROOT, `${asrBase}.json`) : null,
    skipLeadingSegments: skipLeading,
    silence: { noise: options.noise, duration: Number(options.silenceDuration) },
    alignment,
    captions,
};
const temporaryTimingsPath = `${timingsPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryTimingsPath, `${JSON.stringify(timings, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryTimingsPath, timingsPath);

console.log(`ASR JSON: ${path.relative(ROOT, `${asrBase}.json`)}`);
console.log(`Body timings: ${path.relative(ROOT, timingsPath)}`);
