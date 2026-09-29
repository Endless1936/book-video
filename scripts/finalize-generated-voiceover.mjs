#!/usr/bin/env node

// Voiceover finalization.
// - TTS source (default): Whisper checks ONLY that the spoken content matches
//   script.csv — duplication or garbling blocks, everything else warns.
// - Jianying source (--source jianying): Whisper is skipped entirely.
// Timing is produced later by create-body-timings.mjs from silence boundaries.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readCsv } from "./lib/csv.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { fingerprintFile, isFileFingerprintCurrent, validateVoiceoverArtifact } from "./lib/media-validation.mjs";
import { checkScriptContent } from "./lib/body-timings.mjs";
import { completeWorkflowStep } from "./lib/workflow-state.mjs";
import { findLeadingSilence, replaceArtifactsTransactionally } from "./lib/generated-voiceover.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
const [episodeName, ...rawArgs] = process.argv.slice(2);
const episodesRoot = path.resolve(ROOT, "episodes");
const episodeDir = episodeName ? path.resolve(episodesRoot, episodeName) : "";
const audioDir = episodeDir ? path.join(episodeDir, "audio") : "";
const scriptPath = episodeDir ? path.join(episodeDir, "script.csv") : "";
const approvalPath = episodeDir ? path.join(episodeDir, "script-approval.json") : "";
const rawPath = audioDir ? path.join(audioDir, "body-voiceover.raw.mp3") : "";
const finalPath = audioDir ? path.join(audioDir, "body-voiceover.mp3") : "";
const modelPath = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
const referenceVoicePath = path.join(ROOT, "assets", "template-audio", "audio-ref.mp3");
const asrDir = audioDir ? path.join(audioDir, "asr") : "";
const asrBase = asrDir ? path.join(asrDir, "generated-voiceover-check") : "";

let requestedVersion = "";
if (rawArgs[0] && !rawArgs[0].startsWith("--")) requestedVersion = rawArgs.shift();
const sourceFlag = rawArgs.find((arg) => arg === "--source" || arg.startsWith("--source="));
const voiceSource = sourceFlag?.startsWith("--source=")
  ? sourceFlag.slice("--source=".length)
  : (sourceFlag === "--source" ? rawArgs[rawArgs.indexOf(sourceFlag) + 1] : "tts");
if (!["tts", "jianying"].includes(voiceSource)) {
  throw new WorkflowError(`--source must be "tts" or "jianying", found "${voiceSource}".`, {
    code: "invalid_arguments",
  });
}

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/finalize-generated-voiceover.mjs",
  stage: "generated_voiceover_content_gate",
  episodeDir,
  nextActions: [
    "Do not run create-body-timings.mjs or render the episode until this gate passes.",
    "Keep the generated raw audio and existing canonical voiceover unchanged.",
    "Show the per-row Whisper/script differences, then ask whether to regenerate the audio or use a Jianying export.",
  ],
});

if (!episodeName) {
  throw new WorkflowError(
    "Usage: node scripts/finalize-generated-voiceover.mjs <episode-name> [script-version] [--source tts|jianying]",
    { code: "invalid_arguments" },
  );
}
if (!episodeDir.startsWith(`${episodesRoot}${path.sep}`)) {
  throw new WorkflowError("Episode path must stay inside the local episodes directory.", {
    code: "invalid_episode_path",
  });
}
if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
if (!fs.existsSync(scriptPath)) throw new Error(`Missing approved script: ${scriptPath}`);
if (!fs.existsSync(approvalPath)) {
  throw new WorkflowError(`Script approval record is missing: ${approvalPath}`, {
    code: "script_not_approved",
    nextActions: ["Approve the current validated script before generating its voiceover."],
  });
}

const version = resolveScriptVersion(episodeDir, requestedVersion);
const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
if (
  approval.scriptVersion !== version
  || !isFileFingerprintCurrent(scriptPath, approval.scriptFingerprint)
) {
  throw new WorkflowError("The active script is not the unchanged approved version.", {
    code: "script_approval_stale",
    details: { activeVersion: version, approvedVersion: approval.scriptVersion },
    nextActions: ["Resolve and approve the active script version before generating its voiceover."],
  });
}

const rows = readCsv(scriptPath).rows
  .filter((row) => row.version === version)
  .sort((left, right) => Number(left.order) - Number(right.order));
if (!rows.length) throw new Error(`No script rows found for approved version ${version}`);
let displayTitle = "";
try {
  const brief = JSON.parse(fs.readFileSync(path.join(episodeDir, "brief.json"), "utf8"));
  displayTitle = String(brief.display_title || brief.displayTitle || brief.title || "").trim();
} catch {
  displayTitle = "";
}
if (!displayTitle) {
  throw new WorkflowError("The episode brief must contain display_title before voiceover generation.", {
    code: "episode_title_missing",
  });
}
const scriptValidation = validateBodyScript(rows, { episodeTitle: displayTitle });
if (scriptValidation.errors.length) {
  throw new WorkflowError(scriptValidation.errors.join("；"), {
    code: "approved_script_invalid",
    details: scriptValidation,
  });
}
if (rows.some((row) => !String(row.text || "").trim())) {
  throw new WorkflowError("The approved script contains an empty spoken row.", {
    code: "approved_script_invalid",
  });
}

if (voiceSource === "tts" && !fs.existsSync(referenceVoicePath)) {
  throw new WorkflowError(`Required local voice-cloning reference is missing: ${referenceVoicePath}`, {
    code: "voice_reference_missing",
    nextActions: ["Keep the canonical voiceover unchanged and use the manual Jianying export path (--source jianying)."],
  });
}
if (!fs.existsSync(rawPath)) throw new Error(`Generated raw voiceover not found: ${rawPath}`);
const rawVoiceover = validateVoiceoverArtifact(rawPath);
const rawAudioStream = rawVoiceover.probe.streams?.find((stream) => stream.codec_type === "audio");
if (rawAudioStream?.codec_name !== "mp3") {
  throw new WorkflowError(`Generated raw voiceover must be MP3, found ${rawAudioStream?.codec_name || "unknown audio codec"}.`, {
    code: "generated_voiceover_not_mp3",
  });
}
// Warn (don't hard-reject) on suspicious sample-rate/bitrate or long leading
// silence: TTS providers are not committed to specific values, and Whisper is
// no longer the timing source, so these never gate.
const rawSampleRate = Number(rawAudioStream?.sample_rate || 0);
const rawBitRate = Number(rawVoiceover.probe.format?.bit_rate || 0);
if (rawSampleRate && rawSampleRate < 32000) {
  console.warn(
    `[voiceover] WARNING: raw voiceover sample rate is ${rawSampleRate} Hz (< 32 kHz). ` +
    `If this is the high-fidelity TTS master, ignore this warning. If it was a 16kHz copy ` +
    `made for whisper, replace it — whisper-cli resamples internally and the final mix will sound muffled.`,
  );
}
if (rawBitRate && rawBitRate < 160000) {
  console.warn(
    `[voiceover] WARNING: raw voiceover bitrate is ${Math.round(rawBitRate / 1000)} kbps (< 160 kbps). ` +
    `If this is the high-fidelity TTS master, ignore this warning. If it was a whisper-downgraded copy, replace it.`,
  );
}
const leadingSilenceDetect = spawnSync("ffmpeg", [
  "-hide_banner", "-i", rawPath,
  "-af", "silencedetect=noise=-35dB:d=2",
  "-f", "null", "-",
], { encoding: "utf8" });
const leadingSilence = findLeadingSilence(`${leadingSilenceDetect.stderr || ""}`, rawVoiceover.duration);
if (leadingSilence && leadingSilence.start < 0.5 && leadingSilence.end - leadingSilence.start > 3) {
  console.warn(
    `[voiceover] WARNING: raw voiceover has ${leadingSilence.end.toFixed(1)}s of leading silence. ` +
    `Silence-boundary timing tolerates it, but the rendered intro may feel empty. Trim it ` +
    `(e.g. ffmpeg -af "atrim=start=${leadingSilence.end.toFixed(2)},asetpts=PTS-STARTPTS") if it is audible.`,
  );
}

let contentCheck = { textAvailable: false, contentValid: true, diagnostics: { issues: [], rows: [] } };
if (voiceSource === "tts") {
  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 100 * 1024 * 1024) {
    throw new WorkflowError(`A valid local Whisper model is required to check TTS content: ${modelPath}`, {
      code: "whisper_model_unavailable",
      nextActions: [
        "Keep the generated raw audio and existing canonical voiceover unchanged.",
        "Ask the user whether to provide a Jianying export (--source jianying) or install the local Whisper model before continuing.",
      ],
    });
  }
  fs.mkdirSync(asrDir, { recursive: true });
  fs.rmSync(`${asrBase}.json`, { force: true });
  fs.rmSync(`${asrBase}.txt`, { force: true });
  const whisper = spawnSync("whisper-cli", [
    "-ng",
    "-m", modelPath,
    "-l", "zh",
    "-ojf",
    "-otxt",
    "--prompt", displayTitle,
    "-of", asrBase,
    rawPath,
  ], { cwd: ROOT, encoding: "utf8", shell: false });
  if (whisper.status !== 0) {
    const detail = whisper.error?.message || whisper.stderr?.trim() || whisper.stdout?.trim() || `status=${whisper.status}`;
    throw new WorkflowError(`Whisper could not verify generated speech: ${detail.slice(-1800)}`, {
      code: "whisper_verification_failed",
      nextActions: [
        "Keep the generated raw audio and existing canonical voiceover unchanged.",
        "Ask the user whether to provide a Jianying export (--source jianying) or repair Whisper before continuing.",
      ],
    });
  }
  const asrJsonPath = `${asrBase}.json`;
  if (!fs.existsSync(asrJsonPath)) {
    throw new WorkflowError(`Whisper did not create its JSON output: ${asrJsonPath}`, {
      code: "whisper_output_missing",
    });
  }
  const asr = JSON.parse(fs.readFileSync(asrJsonPath, "utf8"));
  contentCheck = checkScriptContent(rows, asr, { episodeTitle: displayTitle });
  if (!contentCheck.contentValid) {
    const differences = (contentCheck.diagnostics.blockingIssues || contentCheck.diagnostics.issues)
      .map((issue) => issue.message);
    throw new WorkflowError(
      `Generated voiceover content check failed (duplicated or garbled speech): ${differences.join(" ")}`,
      {
        code: "generated_voiceover_content_check_failed",
        details: {
          scriptVersion: version,
          scriptRows: rows.length,
          contentCheck: contentCheck.diagnostics,
          rawDurationSeconds: Number(rawVoiceover.duration.toFixed(2)),
          rawVoiceover: path.relative(ROOT, rawPath),
        },
      },
    );
  }
  if (contentCheck.diagnostics.requiresAgentReview) {
    console.warn("Whisper content differs slightly from the approved script; script.csv remains the subtitle truth:");
    console.warn(JSON.stringify({
      issues: contentCheck.diagnostics.issues,
      rows: contentCheck.diagnostics.rows.filter((row) => !row.exact),
    }, null, 2));
  }
} else {
  console.warn(`[voiceover] Jianying source: skipping Whisper content check (${rows.length} rows accepted as-is).`);
}

if (!isFileFingerprintCurrent(scriptPath, approval.scriptFingerprint)) {
  throw new WorkflowError("The approved script changed during voiceover finalization.", {
    code: "script_approval_stale",
  });
}

const runFfmpeg = (args, stage) => {
  const result = spawnSync("ffmpeg", args, { cwd: ROOT, encoding: "utf8", shell: false, stdio: "inherit" });
  if (result.status !== 0) {
    throw new WorkflowError(`ffmpeg failed while ${stage} (status ${result.status ?? "unknown"}).`, {
      code: "voiceover_processing_failed",
      details: { stage, status: result.status, signal: result.signal },
    });
  }
};

fs.mkdirSync(audioDir, { recursive: true });
const suffix = `${process.pid}-${randomUUID()}.candidate`;
const bodyCandidate = `${finalPath}.${suffix}.mp3`;
const bodyWaveCandidate = path.join(audioDir, `.body-voiceover.${suffix}.wav`);

try {
  runFfmpeg([
    "-y", "-i", rawPath,
    "-af", "aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo",
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", bodyWaveCandidate,
  ], "normalizing the voiceover master");
  const processing = spawnSync(process.execPath, [
    path.join(ROOT, "scripts", "process-voiceover.mjs"),
    bodyWaveCandidate,
    bodyCandidate,
    "story",
  ], { cwd: ROOT, encoding: "utf8", shell: false, stdio: "inherit" });
  if (processing.status !== 0) {
    throw new WorkflowError(`Story voiceover processing failed with status ${processing.status ?? "unknown"}.`, {
      code: "voiceover_processing_failed",
    });
  }
  validateVoiceoverArtifact(bodyCandidate);
  if (!isFileFingerprintCurrent(scriptPath, approval.scriptFingerprint)) {
    throw new WorkflowError("The approved script changed while its voiceover was being finalized.", {
      code: "script_approval_stale",
    });
  }

  const replacement = replaceArtifactsTransactionally([
    { candidate: bodyCandidate, destination: finalPath, backup: `${finalPath}.${suffix}.previous` },
  ], {
    afterReplace: () => {
      completeWorkflowStep(episodeDir, "voiced", {
        enforceDependencies: true,
        quality: contentCheck.diagnostics.requiresAgentReview ? "review_required" : "pass",
      });
    },
  });
  for (const backup of replacement.retainedBackups) {
    console.warn(`Could not remove the previous voice artifact; retained recovery backup: ${backup}`);
  }
} finally {
  fs.rmSync(bodyCandidate, { force: true });
  fs.rmSync(bodyWaveCandidate, { force: true });
}

console.log(`Voiceover finalized (${rows.length} approved rows, source: ${voiceSource}).`);
console.log(`Canonical script voiceover: ${path.relative(ROOT, finalPath)}`);
if (voiceSource === "tts") {
  console.log(`Content check: ${contentCheck.diagnostics.contentCheck}`);
}
console.log("Timing will be generated from silence boundaries by create-body-timings.mjs.");
