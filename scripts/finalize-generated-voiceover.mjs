#!/usr/bin/env node

// Host TTS is selected by the Agent. This local gate never calls a TTS provider.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readCsv } from "./lib/csv.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { fingerprintFile, isFileFingerprintCurrent, validateVoiceoverArtifact } from "./lib/media-validation.mjs";
import { alignScriptToWhisper } from "./lib/body-timings.mjs";
import { completeWorkflowStep } from "./lib/workflow-state.mjs";
import {
  deriveGeneratedVoiceoverSplit,
  GENERATED_INTRO_GREETING,
  replaceArtifactsTransactionally,
} from "./lib/generated-voiceover.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
const [episodeName, requestedVersion = ""] = process.argv.slice(2);
const episodesRoot = path.resolve(ROOT, "episodes");
const episodeDir = episodeName ? path.resolve(episodesRoot, episodeName) : "";
const audioDir = episodeDir ? path.join(episodeDir, "audio") : "";
const scriptPath = episodeDir ? path.join(episodeDir, "script.csv") : "";
const approvalPath = episodeDir ? path.join(episodeDir, "script-approval.json") : "";
const rawPath = audioDir ? path.join(audioDir, "body-voiceover.raw.mp3") : "";
const finalPath = audioDir ? path.join(audioDir, "body-voiceover.mp3") : "";
const generatedIntroPath = audioDir ? path.join(audioDir, "intro-voiceover.generated.wav") : "";
const generatedIntroManifestPath = audioDir ? path.join(audioDir, "intro-voiceover.generated.json") : "";
const modelPath = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
const referenceVoicePath = path.join(ROOT, "assets", "template-audio", "audio-ref.mp3");
const standardIntroPath = path.join(ROOT, "assets", "template-audio", "intro-voiceover.mp3");
const asrDir = audioDir ? path.join(audioDir, "asr") : "";
const asrBase = asrDir ? path.join(asrDir, "generated-voiceover-check") : "";

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/finalize-generated-voiceover.mjs",
  stage: "generated_voiceover_alignment_gate",
  episodeDir,
  nextActions: [
    "Do not run create-body-timings.mjs or render the episode until this gate passes.",
    "Keep the generated raw audio and existing canonical voiceover unchanged.",
    "Show the per-row Whisper/script alignment differences, then ask whether to regenerate the audio or use a Jianying export.",
  ],
});

if (!episodeName) {
  throw new WorkflowError(
    "Usage: node scripts/finalize-generated-voiceover.mjs <episode-name> [script-version]",
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
if (!fs.existsSync(referenceVoicePath)) {
  throw new WorkflowError(`Required local voice-cloning reference is missing: ${referenceVoicePath}`, {
    code: "voice_reference_missing",
    nextActions: ["Keep the canonical voiceover unchanged and use the manual Jianying export path."],
  });
}
validateVoiceoverArtifact(referenceVoicePath);
if (!fs.existsSync(rawPath)) throw new Error(`Generated raw voiceover not found: ${rawPath}`);
const rawVoiceover = validateVoiceoverArtifact(rawPath);
const rawAudioStream = rawVoiceover.probe.streams?.find((stream) => stream.codec_type === "audio");
if (rawAudioStream?.codec_name !== "mp3") {
  throw new WorkflowError(`Generated raw voiceover must be MP3, found ${rawAudioStream?.codec_name || "unknown audio codec"}.`, {
    code: "generated_voiceover_not_mp3",
  });
}
// Guard against using a whisper-downgraded copy as the master. whisper-cli reads
// this file directly and resamples internally, so the raw file should always be
// the high-fidelity TTS output — not a 16kHz mono mp3 produced for whisper.
const rawSampleRate = Number(rawAudioStream?.sample_rate || 0);
const rawBitRate = Number(rawVoiceover.probe.format?.bit_rate || 0);
if (rawSampleRate && rawSampleRate < 32000) {
  throw new WorkflowError(
    `Generated raw voiceover sample rate is ${rawSampleRate} Hz, below 32 kHz. ` +
    `This looks like a whisper-downgraded copy, not the high-fidelity TTS master. ` +
    `whisper-cli resamples internally; keep the original high-fidelity audio as raw.`,
    { code: "generated_voiceover_low_sample_rate" },
  );
}
if (rawBitRate && rawBitRate < 160000) {
  throw new WorkflowError(
    `Generated raw voiceover bitrate is ${Math.round(rawBitRate / 1000)} kbps, below 160 kbps. ` +
    `This looks like a whisper-downgraded copy, not the high-fidelity TTS master.`,
    { code: "generated_voiceover_low_bitrate" },
  );
}
// Guard against long leading silence, which confuses whisper's greeting detection
// (the cloned "今天分享的是" prefix can get placed at t=0 while real speech starts
// several seconds in).
const leadingSilenceDetect = spawnSync("ffmpeg", [
  "-hide_banner", "-i", rawPath,
  "-af", "silencedetect=noise=-35dB:d=2",
  "-f", "null", "-",
], { encoding: "utf8" });
const silenceLog = `${leadingSilenceDetect.stderr || ""}`;
const leadingMatch = silenceLog.match(/silence_start: ([\d.]+)/);
if (leadingMatch && Number(leadingMatch[1]) > 3) {
  const leadSec = Number(leadingMatch[1]).toFixed(1);
  throw new WorkflowError(
    `Generated raw voiceover has ${leadSec}s of leading silence. ` +
    `Trim it (e.g. ffmpeg -af "atrim=${Number(leadingMatch[1]).toFixed(2)},asetpts=PTS-STARTPTS") ` +
    `so whisper can place the greeting correctly.`,
    { code: "generated_voiceover_long_leading_silence" },
  );
}
if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 100 * 1024 * 1024) {
  throw new WorkflowError(`A valid local Whisper model is required for the generated-voice alignment gate: ${modelPath}`, {
    code: "whisper_model_unavailable",
    nextActions: [
      "Keep the generated raw audio and existing canonical voiceover unchanged.",
      "Ask the user whether to provide a Jianying export or install the local Whisper model before continuing.",
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
  "-of", asrBase,
  rawPath,
], { cwd: ROOT, encoding: "utf8", shell: false });
if (whisper.status !== 0) {
  const detail = whisper.error?.message || whisper.stderr?.trim() || whisper.stdout?.trim() || `status=${whisper.status}`;
  throw new WorkflowError(`Whisper could not verify generated speech: ${detail.slice(-1800)}`, {
    code: "whisper_verification_failed",
    nextActions: [
      "Keep the generated raw audio and existing canonical voiceover unchanged.",
      "Ask the user whether to provide a Jianying export or repair Whisper before continuing.",
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
const scriptAlignment = alignScriptToWhisper(rows, asr, {
  episodeTitle: displayTitle,
  audioDuration: rawVoiceover.duration,
});
if (
  !scriptAlignment.sequenceMappable
  || !scriptAlignment.timestampsAvailable
  || scriptAlignment.captions.length !== rows.length
  || !scriptAlignment.captions.every((caption) => Number.isFinite(caption.start) && Number.isFinite(caption.end))
) {
  const differences = scriptAlignment.diagnostics.issues.map((issue) => issue.message);
  throw new WorkflowError(
    `Generated voiceover alignment blocked: ${differences.join(" ") || "Whisper could not map the approved script to token timestamps."}`,
    {
      code: "generated_voiceover_script_alignment_failed",
      details: {
        scriptVersion: version,
        scriptRows: rows.length,
        alignment: scriptAlignment.diagnostics,
        rawDurationSeconds: Number(rawVoiceover.duration.toFixed(2)),
        rawVoiceover: path.relative(ROOT, rawPath),
        whisperJson: path.relative(ROOT, asrJsonPath),
      },
    },
  );
}

if (scriptAlignment.diagnostics.requiresAgentReview || !scriptAlignment.contentValid) {
  console.warn("Whisper text differs from the approved script; review the audio and keep script.csv as subtitle truth:");
  console.warn(JSON.stringify({
    issues: scriptAlignment.diagnostics.issues,
    rows: scriptAlignment.diagnostics.rows.filter((row) => !row.exact),
  }, null, 2));
}

if (!isFileFingerprintCurrent(scriptPath, approval.scriptFingerprint)) {
  throw new WorkflowError("The approved script changed during generated-voice verification.", {
    code: "script_approval_stale",
  });
}

const standardIntroDuration = validateVoiceoverArtifact(standardIntroPath).duration;
let split;
try {
  split = deriveGeneratedVoiceoverSplit(scriptAlignment, {
    standardIntroDuration,
    rawDuration: rawVoiceover.duration,
  });
} catch (error) {
  throw new WorkflowError(error.message, {
    code: error.code || "generated_voiceover_split_failed",
    details: {
      alignment: scriptAlignment.diagnostics,
      standardIntroDuration,
      rawDuration: rawVoiceover.duration,
    },
    nextActions: [
      "Keep the current canonical voiceover and intro unchanged.",
      "Regenerate the cloned greeting and script together, then rerun this gate.",
      "If the free Doubao clone cannot produce a clean split, use the Jianying voiceover path.",
    ],
  });
}

const runFfmpeg = (args, stage) => {
  const result = spawnSync("ffmpeg", args, { cwd: ROOT, encoding: "utf8", shell: false, stdio: "inherit" });
  if (result.status !== 0) {
    throw new WorkflowError(`ffmpeg failed while ${stage} (status ${result.status ?? "unknown"}).`, {
      code: "generated_voiceover_split_failed",
      details: { stage, status: result.status, signal: result.signal },
    });
  }
};

fs.mkdirSync(audioDir, { recursive: true });
const suffix = `${process.pid}-${randomUUID()}.candidate`;
const introCandidate = `${generatedIntroPath}.${suffix}.wav`;
const bodyWaveCandidate = path.join(audioDir, `.body-voiceover.${suffix}.wav`);
const bodyCandidate = `${finalPath}.${suffix}.mp3`;
const manifestCandidate = `${generatedIntroManifestPath}.${suffix}.json`;
const filesToReplace = [
  { candidate: introCandidate, destination: generatedIntroPath, backup: `${generatedIntroPath}.${suffix}.previous` },
  { candidate: bodyCandidate, destination: finalPath, backup: `${finalPath}.${suffix}.previous` },
  { candidate: manifestCandidate, destination: generatedIntroManifestPath, backup: `${generatedIntroManifestPath}.${suffix}.previous` },
];

try {
  const pcmFormat = "aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo";
  runFfmpeg([
    "-y", "-i", rawPath,
    "-af", `atrim=start=0:end=${split.introSourceEnd.toFixed(6)},asetpts=PTS-STARTPTS,apad,atrim=duration=${standardIntroDuration.toFixed(6)},${pcmFormat}`,
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", introCandidate,
  ], "extracting and padding the cloned greeting");
  runFfmpeg([
    "-y", "-i", rawPath,
    "-af", `atrim=start=${split.bodySourceStart.toFixed(6)},asetpts=PTS-STARTPTS,${pcmFormat}`,
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", bodyWaveCandidate,
  ], "separating the script voiceover");

  const introArtifact = validateVoiceoverArtifact(introCandidate);
  const sampleDuration = 1 / 48000;
  if (Math.abs(introArtifact.duration - standardIntroDuration) > sampleDuration) {
    throw new WorkflowError(
      `Generated greeting duration ${introArtifact.duration.toFixed(6)}s does not exactly match the standard ${standardIntroDuration.toFixed(6)}s.`,
      { code: "generated_intro_duration_mismatch" },
    );
  }

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
    throw new WorkflowError("The approved script changed while its generated voiceover was being finalized.", {
      code: "script_approval_stale",
    });
  }

  const manifest = {
    scriptVersion: version,
    scriptFingerprint: fingerprintFile(scriptPath),
    bodyVoiceFingerprint: fingerprintFile(bodyCandidate),
    generatedIntroFingerprint: fingerprintFile(introCandidate),
    introDurationSeconds: introArtifact.duration,
    greetingText: GENERATED_INTRO_GREETING,
    greetingSpeechEndSeconds: split.greetingSpeechEnd,
    titleSpeechStartSeconds: split.titleSpeechStart,
  };
  fs.writeFileSync(manifestCandidate, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const replacement = replaceArtifactsTransactionally(filesToReplace, {
    afterReplace: () => {
      completeWorkflowStep(episodeDir, "voiced", {
        enforceDependencies: true,
        quality: scriptAlignment.diagnostics.requiresAgentReview ? "review_required" : "pass",
      });
    },
  });
  for (const backup of replacement.retainedBackups) {
    console.warn(`Could not remove the previous generated voice artifact; retained recovery backup: ${backup}`);
  }
} finally {
  fs.rmSync(introCandidate, { force: true });
  fs.rmSync(bodyWaveCandidate, { force: true });
  fs.rmSync(bodyCandidate, { force: true });
  fs.rmSync(manifestCandidate, { force: true });
}

console.log(`Generated voiceover passed script-to-Whisper alignment (${rows.length} approved rows).`);
console.log(`Detected cloned greeting: ${scriptAlignment.diagnostics.detectedLeadIn?.text || "none"}.`);
console.log(`Raw duration: ${rawVoiceover.duration.toFixed(2)} seconds.`);
console.log(`Exact-length generated intro: ${path.relative(ROOT, generatedIntroPath)} (${standardIntroDuration.toFixed(3)}s).`);
console.log(`Canonical script voiceover: ${path.relative(ROOT, finalPath)}`);
