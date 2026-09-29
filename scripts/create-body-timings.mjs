#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  alignScriptToWhisper,
  buildCaptionTimings,
  buildEstimatedCaptionTimings,
  buildSpeechSegments,
  coalesceSpeechSegments,
  deriveSkipLeadingSegments,
  parseSilenceEvents,
} from "./lib/body-timings.mjs";
import { readCsv } from "./lib/csv.mjs";
import { fingerprintFile, isFileFingerprintCurrent, validateVoiceoverArtifact } from "./lib/media-validation.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";
import { beginWorkflowStep, completeWorkflowStep } from "./lib/workflow-state.mjs";

const ROOT = process.cwd();
const MODEL_PATH = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
const [episodeName, ...rawArgs] = process.argv.slice(2);
const episodeDir = episodeName ? path.join(ROOT, "episodes", episodeName) : "";

function readOptions(values) {
  const positional = [];
  const options = { noise: "-35dB", silenceDuration: "0.18", voiceoverNotBefore: "" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--skip-leading" || value.startsWith("--skip-leading=")) {
      throw new WorkflowError("--skip-leading is no longer accepted; Whisper derives any spoken lead-in automatically.", {
        code: "manual_skip_leading_removed",
        nextActions: ["Remove --skip-leading and rerun; inspect the Whisper alignment report if the lead-in is unexpected."],
      });
    }
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
if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
const scriptVersion = resolveScriptVersion(episodeDir, requestedVersion);
const audioDir = path.join(episodeDir, "audio");
const scriptPath = path.join(episodeDir, "script.csv");
const defaultVoicePath = path.join(episodeDir, "audio", "body-voiceover.mp3");
const voicePath = path.resolve(ROOT, positional[0] || defaultVoicePath);
const workflowDependencies = voicePath === path.resolve(defaultVoicePath) ? undefined : ["script_approved"];
const asrDir = path.join(audioDir, "asr");
const asrBase = path.join(asrDir, "body");
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
let skipLeading = 0;
let alignment = {
  method: "speech-duration-estimate",
  speechSegments: speechSegments.length,
  silenceDetectionAvailable: !silenceFailure,
  contentCheck: "unavailable",
  contentCheckReason: "Whisper text was not available; caption text remains script.csv and timing requires Agent review.",
  requiresAgentReview: true,
};
let whisperAlignment = null;
if (!whisperFailure) {
  whisperAlignment = alignScriptToWhisper(rows, asr, { episodeTitle: displayTitle, audioDuration: duration });
  const skipLeadingResult = deriveSkipLeadingSegments(speechSegments, whisperAlignment);
  if (!skipLeadingResult.canDerive) {
    throw new WorkflowError(
      `Whisper detected spoken lead-in “${whisperAlignment.diagnostics.detectedLeadIn.text}”, but complete token offsets are unavailable. The lead-in cannot be safely separated from script timing.`,
      {
        code: "voiceover_script_alignment_failed",
        details: {
          reason: "lead_in_token_timestamps_required",
          scriptVersion,
          alignment: whisperAlignment.diagnostics,
          voiceover: path.relative(ROOT, voicePath),
          whisperJson: fs.existsSync(`${asrBase}.json`) ? path.relative(ROOT, `${asrBase}.json`) : null,
        },
        nextActions: [
          "Regenerate Whisper JSON with token offsets, then rerun timing generation.",
          "If token offsets remain unavailable, inspect the audio and decide the lead-in boundary before proceeding.",
        ],
      },
    );
  }
  skipLeading = skipLeadingResult.skipLeading;
  if (whisperAlignment.textAvailable && !whisperAlignment.sequenceMappable) {
    const differences = whisperAlignment.diagnostics.issues.map((issue) => issue.message).join(" ");
    throw new WorkflowError(`Voiceover/script sequence mismatch; timing generation is blocked: ${differences}`, {
      code: "voiceover_script_alignment_failed",
      details: {
        scriptVersion,
        alignment: whisperAlignment.diagnostics,
        voiceover: path.relative(ROOT, voicePath),
        whisperJson: fs.existsSync(`${asrBase}.json`) ? path.relative(ROOT, `${asrBase}.json`) : null,
      },
      nextActions: [
        "Review the listed missing, extra, or out-of-order speech against the voiceover.",
        "Correct or replace the voiceover, then rerun timing generation after the script sequence can be mapped.",
      ],
    });
  }
  if (whisperAlignment.textAvailable && !whisperAlignment.contentValid) {
    const differences = whisperAlignment.diagnostics.issues.map((issue) => issue.message).join(" ");
    console.warn(`Whisper text differs from the approved script; mapping by script order and retaining script.csv as subtitle truth: ${differences}`);
    whisperAlignment.diagnostics.requiresAgentReview = true;
  }
  if (
    whisperAlignment.sequenceMappable
    && whisperAlignment.timestampsAvailable
    && whisperAlignment.captions.length === rows.length
    && whisperAlignment.captions.every((caption) => Number.isFinite(caption.start) && Number.isFinite(caption.end))
  ) {
    captions = whisperAlignment.captions;
    alignment = {
      method: "whisper-token-script-alignment",
      speechSegments: speechSegments.length,
      silenceDetectionAvailable: !silenceFailure,
      contentCheck: whisperAlignment.diagnostics.contentCheck,
      requiresAgentReview: Boolean(whisperAlignment.diagnostics.requiresAgentReview),
      scriptAlignment: whisperAlignment.diagnostics,
    };
    if (alignment.requiresAgentReview) {
      console.warn("Whisper alignment passed with tolerated recognition differences; review each row's recognizedText and coverage before rendering.");
    }

    if (captions.length && speechSegments.length) {
      const firstTokenStart = captions[0].start;
      alignment.firstTokenToCaptionStartSeconds = Number(Math.abs(
        firstTokenStart - whisperAlignment.firstScriptTokenTime,
      ).toFixed(2));
      const silenceSegmentIndex = speechSegments.findIndex((segment) =>
        segment.start <= firstTokenStart + 0.15 && segment.end >= firstTokenStart - 0.15);
      const silenceStart = silenceSegmentIndex >= 0 ? speechSegments[silenceSegmentIndex].start : null;
      const firstCaptionDriftSeconds = silenceStart === null ? null : Number(Math.abs(firstTokenStart - silenceStart).toFixed(2));
      alignment.firstCaptionDriftSeconds = firstCaptionDriftSeconds;
      alignment.captionStartCrossCheckPassed = firstCaptionDriftSeconds !== null && firstCaptionDriftSeconds < 0.4;
      if (!alignment.captionStartCrossCheckPassed) {
        alignment.requiresAgentReview = true;
        console.warn(
          firstCaptionDriftSeconds === null
            ? "Whisper/silence cross-check unavailable for caption #1; review the first caption start manually."
          : `Caption #1 differs from the silencedetect boundary by ${firstCaptionDriftSeconds}s (limit 0.4s); review timing before rendering.`,
        );
      }
    } else {
      alignment.requiresAgentReview = true;
      alignment.firstTokenToCaptionStartSeconds = captions.length
        ? Number(Math.abs(captions[0].start - whisperAlignment.firstScriptTokenTime).toFixed(2))
        : null;
      alignment.captionStartCrossCheckPassed = false;
      console.warn("Whisper token alignment succeeded, but no silencedetect boundary was available to cross-check caption #1.");
    }
  } else {
    const difference = whisperAlignment.diagnostics.issues.map((issue) => issue.message).join(" ");
    console.warn(`Whisper/script alignment needs review; using duration-based fallback: ${difference}`);
    alignment.contentCheck = whisperAlignment.textAvailable
      ? whisperAlignment.diagnostics.contentCheck || "matched_with_timing_fallback"
      : "unavailable";
    alignment.contentCheckReason = whisperAlignment.textAvailable
      ? "Whisper text was available, but token timestamps were not suitable for direct caption alignment."
      : "Whisper returned no readable text; script content could not be checked against the audio.";
  }
}
if (!captions) {
  try {
    const selectedSpeechSegments = speechSegments.slice(skipLeading);
    const normalizedSegments = coalesceSpeechSegments(selectedSpeechSegments, rows.length);
    captions = buildCaptionTimings(rows.map((row) => row.order), normalizedSegments);
    alignment.method = "silence-segments";
    alignment.fallbackReason = whisperFailure?.message
      || whisperAlignment?.diagnostics.issues.map((issue) => issue.message).join(" ")
      || "Whisper alignment did not yield caption timings.";
  } catch (error) {
    captions = buildEstimatedCaptionTimings(rows, speechSegments.slice(skipLeading), duration);
    alignment.method = "speech-duration-estimate";
    alignment.fallbackReason = error.message;
    console.warn(`Speech pauses were insufficient; continuing with duration estimate: ${error.message}`);
  }
  alignment.silenceDetectionAvailable = !silenceFailure;
  alignment.requiresAgentReview = true;
  if (whisperAlignment) alignment.scriptAlignment = whisperAlignment.diagnostics;
}
alignment.asrAvailable = !whisperFailure;
alignment.asrText = (asr.transcription || []).map((segment) => segment.text).join("");
if (!whisperAlignment?.textAvailable) {
  alignment.contentCheck = "unavailable";
  alignment.contentCheckReason = whisperFailure
    ? "Whisper could not provide readable transcript text."
    : "Whisper returned no readable transcript text.";
  alignment.requiresAgentReview = true;
}
if (!isFileFingerprintCurrent(scriptPath, scriptFingerprint)) {
  throw new WorkflowError("script.csv changed during timing generation; refusing to save timings for a different script snapshot.", {
    code: "script_changed_during_timing",
    details: { scriptVersion, script: path.relative(ROOT, scriptPath) },
    nextActions: ["Review the current approved script, then rerun timing generation."],
  });
}
const timings = {
    scriptVersion,
    duration: Number(duration.toFixed(2)),
    source: `script.csv subtitle truth with ${alignment.method}`,
    audio: path.relative(ROOT, voicePath),
    audioFingerprint: voiceover.fingerprint,
    scriptFingerprint,
    asr: fs.existsSync(`${asrBase}.json`) ? path.relative(ROOT, `${asrBase}.json`) : null,
    skipLeadingSegments: skipLeading,
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
    quality: alignment.requiresAgentReview ? "degraded" : "pass",
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

console.log(`ASR JSON: ${path.relative(ROOT, `${asrBase}.json`)}`);
console.log(`Body timings: ${path.relative(ROOT, timingsPath)}`);
