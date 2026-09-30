#!/usr/bin/env node

// Voiceover finalization.
// - TTS includes the cloned opener, title, and body in one pass. Whisper checks
//   text only; FFmpeg silence boundaries split the opener from the script.
// - Jianying input is read from body-voiceover.mp3 and skips Whisper entirely.
// Caption timing is produced later from FFmpeg silence boundaries.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readCsv } from "./lib/csv.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { fingerprintFile, isFileFingerprintCurrent, validateVoiceoverArtifact } from "./lib/media-validation.mjs";
import { buildSpeechSegments, checkScriptContent, parseSilenceEvents } from "./lib/body-timings.mjs";
import { completeWorkflowStep } from "./lib/workflow-state.mjs";
import { findLeadingSilence, replaceArtifactsTransactionally } from "./lib/generated-voiceover.mjs";
import { resolveVoiceProfile } from "./lib/voice-profiles.mjs";
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
const generatedIntroPath = audioDir ? path.join(audioDir, "intro-voiceover.generated.wav") : "";
const generatedIntroManifestPath = audioDir ? path.join(audioDir, "intro-voiceover.generated.json") : "";
const modelPath = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
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
const voiceoverInputPath = voiceSource === "tts" ? rawPath : finalPath;

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/finalize-generated-voiceover.mjs",
  stage: "generated_voiceover_finalize",
  episodeDir,
  nextActions: [
    "Inspect the reported audio input or media-processing error and fix that narrow issue.",
    "Retry finalization; existing canonical voiceover files remain in place until a candidate succeeds.",
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
const voiceProfile = resolveVoiceProfile(ROOT, episodeDir);
const standardIntroPath = voiceProfile.introPath;
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

if (!fs.existsSync(voiceoverInputPath)) {
  throw new WorkflowError(`Voiceover file not found: ${voiceoverInputPath}`, {
    code: voiceSource === "tts" ? "generated_voiceover_missing" : "jianying_voiceover_missing",
    nextActions: [voiceSource === "tts"
      ? "Save the one-pass cloned opener, title, and body to body-voiceover.raw.mp3."
      : "Export the approved title and body from Jianying to body-voiceover.mp3."],
  });
}
const sourceVoiceover = validateVoiceoverArtifact(voiceoverInputPath);
const sourceAudioStream = sourceVoiceover.probe.streams?.find((stream) => stream.codec_type === "audio");
if (sourceAudioStream?.codec_name !== "mp3") {
  throw new WorkflowError(`Voiceover must be MP3, found ${sourceAudioStream?.codec_name || "unknown audio codec"}.`, {
    code: "voiceover_not_mp3",
  });
}
// Warn (don't hard-reject) on suspicious sample-rate/bitrate or long leading
// silence: TTS providers are not committed to specific values, and Whisper is
// no longer the timing source, so these never gate.
const rawSampleRate = Number(sourceAudioStream?.sample_rate || 0);
const rawBitRate = Number(sourceVoiceover.probe.format?.bit_rate || 0);
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
  "-hide_banner", "-i", voiceoverInputPath,
  "-af", "silencedetect=noise=-35dB:d=2",
  "-f", "null", "-",
], { encoding: "utf8" });
const leadingSilence = findLeadingSilence(`${leadingSilenceDetect.stderr || ""}`, sourceVoiceover.duration);
if (leadingSilence && leadingSilence.start < 0.5 && leadingSilence.end - leadingSilence.start > 3) {
  console.warn(
    `[voiceover] WARNING: voiceover has ${leadingSilence.end.toFixed(1)}s of leading silence. ` +
    `Silence-boundary timing tolerates it, but the rendered intro may feel empty. Trim it ` +
    `(e.g. ffmpeg -af "atrim=start=${leadingSilence.end.toFixed(2)},asetpts=PTS-STARTPTS") if it is audible.`,
  );
}

let contentCheck = {
  textAvailable: false,
  contentValid: true,
  diagnostics: {
    issues: [],
    rows: [],
    contentCheck: voiceSource === "tts" ? "unavailable" : "skipped_jianying",
    requiresAgentReview: voiceSource === "tts",
  },
};
function noteWhisperUnavailable(reason) {
  contentCheck = {
    textAvailable: false,
    contentValid: true,
    diagnostics: {
      issues: [],
      rows: [],
      contentCheck: "unavailable",
      contentCheckReason: reason,
      requiresAgentReview: true,
    },
  };
  console.warn(`Whisper content check unavailable: ${reason}. Continuing with Agent review; no timing depends on Whisper.`);
}

if (voiceSource === "tts") {
  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 100 * 1024 * 1024) {
    noteWhisperUnavailable("local model missing or invalid");
  } else {
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
      noteWhisperUnavailable(detail.slice(-1800));
    } else if (!fs.existsSync(`${asrBase}.json`)) {
      noteWhisperUnavailable("Whisper produced no JSON transcript");
    } else {
      try {
        const asr = JSON.parse(fs.readFileSync(`${asrBase}.json`, "utf8"));
        contentCheck = checkScriptContent(rows, asr, { episodeTitle: displayTitle });
        if (!contentCheck.textAvailable) {
          noteWhisperUnavailable(contentCheck.diagnostics.contentCheckReason || "Whisper returned no readable speech text");
        } else if (!contentCheck.contentValid) {
          const differences = (contentCheck.diagnostics.reviewIssues || contentCheck.diagnostics.issues)
            .map((issue) => issue.message);
          contentCheck.diagnostics.requiresAgentReview = true;
          console.warn("Whisper found possible content differences; continuing because ASR is review evidence, not a gate:");
          console.warn(differences.join(" "));
        } else if (contentCheck.diagnostics.requiresAgentReview) {
          console.warn("Whisper found minor script-text variance; script.csv remains the subtitle truth:");
          console.warn(JSON.stringify({
            issues: contentCheck.diagnostics.issues,
            rows: contentCheck.diagnostics.rows.filter((row) => !row.exact),
          }, null, 2));
        }
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        noteWhisperUnavailable(error.message || "Whisper JSON could not be read");
      }
    }
  }
} else {
  console.warn(`Jianying source: skipping Whisper content check (${rows.length} rows accepted as-is).`);
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

let generatedIntroSplit = null;
let standardIntroDuration = 0;
if (voiceSource === "tts") {
  const boundaryDetection = spawnSync("ffmpeg", [
    "-hide_banner", "-i", rawPath,
    "-af", "silencedetect=noise=-35dB:d=0.25",
    "-f", "null", "-",
  ], { encoding: "utf8", shell: false });
  if (boundaryDetection.status === 0) {
    const speechSegments = buildSpeechSegments(
      sourceVoiceover.duration,
      parseSilenceEvents(`${boundaryDetection.stdout || ""}\n${boundaryDetection.stderr || ""}`),
    );
    if (speechSegments.length >= 2) {
      generatedIntroSplit = {
        greeting: speechSegments[0],
        bodyStart: speechSegments[1].start,
      };
      // A cloned TTS opener may itself be two speech segments: the greeting
      // ("今天分享的是") followed by the book title read out loud. In that case
      // the greeting stays in the intro and the spoken title becomes the HEAD
      // of the body voiceover — right before the first script line, so the
      // title and the body captions are voiced together through the same
      // story processing and the same timeline. The body start is pulled back
      // slightly so the leading consonant of the title (e.g. "被") is not cut
      // in half by the silence boundary.
      if (speechSegments.length >= 3) {
        generatedIntroSplit.title = speechSegments[1];
        generatedIntroSplit.bodyStart = Math.max(0, speechSegments[1].start - 0.08);
      }
      standardIntroDuration = validateVoiceoverArtifact(standardIntroPath).duration;
    }
  }
  if (!generatedIntroSplit) {
    console.warn(
      "[voiceover] Could not confidently separate a cloned greeting using silence boundaries. " +
      "Keeping the TTS audio intact and using the shared intro; review for a repeated opener.",
    );
    contentCheck.diagnostics.requiresAgentReview = true;
  }
}

if (!isFileFingerprintCurrent(scriptPath, approval.scriptFingerprint)) {
  throw new WorkflowError("The approved script changed during voiceover finalization.", {
    code: "script_approval_stale",
  });
}

fs.mkdirSync(audioDir, { recursive: true });
const suffix = `${process.pid}-${randomUUID()}.candidate`;
const bodyCandidate = `${finalPath}.${suffix}.mp3`;
const bodyWaveCandidate = path.join(audioDir, `.body-voiceover.${suffix}.wav`);
const introCandidate = `${generatedIntroPath}.${suffix}.wav`;
const manifestCandidate = `${generatedIntroManifestPath}.${suffix}.json`;

try {
  const pcmFormat = "aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo";
  const bodySourceStart = generatedIntroSplit?.bodyStart || 0;
  // Jianying exports carry a high-frequency noise floor that loudness
  // normalization later amplifies into audible hiss between sentences. Reduce
  // it at the source, before the story preset; TTS output is left untouched.
  const sourceDenoise = voiceSource === "jianying"
    ? ["afftdn=nr=18:nf=-45"]
    : [];
  const bodyFilters = [
    `atrim=start=${bodySourceStart.toFixed(6)}`,
    "asetpts=PTS-STARTPTS",
    ...sourceDenoise,
    pcmFormat,
  ].join(",");
  runFfmpeg([
    "-y", "-i", voiceoverInputPath,
    "-af", bodyFilters,
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", bodyWaveCandidate,
  ], "preparing the script voiceover");

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

  const filesToReplace = [
    { candidate: bodyCandidate, destination: finalPath, backup: `${finalPath}.${suffix}.previous` },
  ];
  if (generatedIntroSplit) {
    // The intro voiceover is the greeting only ("今天分享的是"), padded to the
    // shared intro duration. The spoken book title is NOT merged into the
    // greeting and NOT cut into its own track: it heads the body voiceover
    // (see bodyStart above) so it is processed and timed together with the
    // body captions.
    const introEnd = generatedIntroSplit.greeting.end;
    const greetingDuration = introEnd - generatedIntroSplit.greeting.start;
    if (greetingDuration > standardIntroDuration) {
      throw new WorkflowError(
        `The generated greeting (${greetingDuration.toFixed(3)}s) is longer than the shared intro (${standardIntroDuration.toFixed(3)}s); it cannot be kept at natural speed without being cut off.`,
        { code: "generated_intro_duration_mismatch" },
      );
    }
    const introFilters = [
      `atrim=start=${generatedIntroSplit.greeting.start.toFixed(6)}:end=${introEnd.toFixed(6)}`,
      "asetpts=PTS-STARTPTS",
      "apad",
      `atrim=duration=${standardIntroDuration.toFixed(6)}`,
      pcmFormat,
    ].join(",");
    runFfmpeg([
      "-y", "-i", rawPath,
      "-af", introFilters,
      "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", introCandidate,
    ], "making the cloned opener match the shared intro duration");
    const introArtifact = validateVoiceoverArtifact(introCandidate);
    if (Math.abs(introArtifact.duration - standardIntroDuration) > 1 / 48000) {
      throw new WorkflowError("The generated opener could not be padded to the shared intro duration.", {
        code: "generated_intro_duration_mismatch",
      });
    }

    const manifest = {
      voiceSource: "tts",
      voiceProfile: voiceProfile.id,
      scriptVersion: version,
      scriptFingerprint: fingerprintFile(scriptPath),
      bodyVoiceFingerprint: fingerprintFile(bodyCandidate),
      generatedIntroFingerprint: fingerprintFile(introCandidate),
      introDurationSeconds: introArtifact.duration,
      greetingText: contentCheck.diagnostics.detectedLeadIn?.text || "今天分享的是",
      greetingSpeechEndSeconds: greetingDuration,
      titleSpeechStartSeconds: generatedIntroSplit.title
        ? generatedIntroSplit.title.start
        : generatedIntroSplit.bodyStart,
    };
    fs.writeFileSync(manifestCandidate, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    filesToReplace.push(
      { candidate: introCandidate, destination: generatedIntroPath, backup: `${generatedIntroPath}.${suffix}.previous` },
      { candidate: manifestCandidate, destination: generatedIntroManifestPath, backup: `${generatedIntroManifestPath}.${suffix}.previous` },
    );
  }

  const replacement = replaceArtifactsTransactionally(filesToReplace, {
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
  fs.rmSync(introCandidate, { force: true });
  fs.rmSync(bodyCandidate, { force: true });
  fs.rmSync(bodyWaveCandidate, { force: true });
  fs.rmSync(manifestCandidate, { force: true });
}

console.log(`Voiceover finalized (${rows.length} approved rows, source: ${voiceSource}).`);
console.log(`Canonical script voiceover: ${path.relative(ROOT, finalPath)}`);
if (voiceSource === "tts") {
  console.log(`Content check: ${contentCheck.diagnostics.contentCheck || "unavailable"}`);
  console.log(generatedIntroSplit
    ? `Cloned intro: ${path.relative(ROOT, generatedIntroPath)} (${standardIntroDuration.toFixed(3)}s).`
    : "Intro source: shared template (review the TTS opening).");
}
console.log("Timing will be generated from silence boundaries by create-body-timings.mjs.");
