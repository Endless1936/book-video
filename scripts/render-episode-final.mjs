#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readCsv } from "./lib/csv.mjs";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { fingerprintFile, isFileFingerprintCurrent, probeMedia } from "./lib/media-validation.mjs";
import { resolvePreviewBodyTimings } from "./lib/preview-body-timings.mjs";
import { buildProductionReport } from "./lib/production-report.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { INTRO_VIDEO_TRIM_SECONDS } from "./lib/generated-voiceover.mjs";
import { resolveVoiceProfile } from "./lib/voice-profiles.mjs";
import { getAtmosphereImageNames } from "./lib/body-scenes.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";
import {
  assertRenderTimingPreflight,
  beginWorkflowStep,
  completeWorkflowStep,
} from "./lib/workflow-state.mjs";

const ROOT = process.cwd();
const [episodeName, requestedVersion, bgmInput] = process.argv.slice(2);
const episodeDir = episodeName ? path.join(ROOT, "episodes", episodeName) : "";
installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/render-episode-final.mjs",
  stage: "final_render",
  episodeDir,
  workflowStep: "rendered",
  nextActions: [
    "Inspect the failed command, referenced media, and tmp preview artifacts.",
    "Correct only the failing input or dependency, then rerun the render.",
    "Keep the previous active render until the new candidate passes technical checks.",
    "After a successful render, inspect representative frames and update production-report.json.",
  ],
});
const HYPERFRAMES_VERSION = "0.7.33";
// The intro video/audio offset must equal the ACTUAL intro voiceover length
// (the generated clone is ~3.03s, not the template constant 2.38s), otherwise
// the book-title outro overlaps the first body caption. Re-measured below.
let introTrimSeconds = INTRO_VIDEO_TRIM_SECONDS;
let introOffsetMs = Math.round(introTrimSeconds * 1000);
const FINAL_BGM_BASE_VOLUME = 0.32;
const FINAL_BGM_GAIN_DB = Number(process.env.FINAL_BGM_GAIN_DB || "0");
if (!Number.isFinite(FINAL_BGM_GAIN_DB)) {
  throw new Error(`Invalid FINAL_BGM_GAIN_DB: ${process.env.FINAL_BGM_GAIN_DB}`);
}
const FINAL_BGM_VOLUME = Number((FINAL_BGM_BASE_VOLUME * Math.pow(10, FINAL_BGM_GAIN_DB / 20)).toFixed(4));
const ALLOW_OVER_60_SECONDS = process.env.ALLOW_OVER_60_SECONDS === "1";
const INTRO_SCROLL_SFX_START_SECONDS = 1.08;
const INTRO_SCROLL_SFX_END_SECONDS = 2.38;
const INTRO_SCROLL_SFX_FADE_OUT_SECONDS = 0.2;
const INTRO_SCROLL_SFX_VOLUME = 1.4;
const INTRO_SCROLL_SFX_PATH = path.join(ROOT, "assets", "sfx", "gear-scroll.mp3");

if (!episodeName) {
  throw new WorkflowError("Usage: node scripts/render-episode-final.mjs <episode-name> [script-version] [bgm-file-or-name]", {
    code: "invalid_arguments",
  });
}
if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
const voiceProfile = resolveVoiceProfile(ROOT, episodeDir);
assertRenderTimingPreflight(episodeDir);
beginWorkflowStep(episodeDir, "rendered", { enforceDependencies: true });

function chooseRandomBgm() {
  const bgmDir = path.join(ROOT, "assets", "bgm");
  const available = fs.existsSync(bgmDir)
    ? fs.readdirSync(bgmDir).filter((name) => name.toLowerCase().endsWith(".mp3"))
    : [];
  if (available.length === 0) {
    throw new Error(`No shared BGM found in ${bgmDir}`);
  }
  return available[Math.floor(Math.random() * available.length)];
}

const bgmArg = bgmInput || chooseRandomBgm();

function slugifyBgmName(input) {
  const name = path.basename(input, path.extname(input));
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "bgm";
}

const slug = slugifyEpisodeName(episodeName);
const bgmSlug = slugifyBgmName(bgmArg);
const scriptVersion = resolveScriptVersion(episodeDir, requestedVersion);
const audioDir = path.join(episodeDir, "audio");
const imagesDir = path.join(episodeDir, "images");
const scriptPath = path.join(episodeDir, "script.csv");
const rendersDir = path.join(episodeDir, "renders");
const timingsPath = path.join(audioDir, "body-timings.json");
const previewDir = path.join(ROOT, "tmp", `preview-${slug}`);
const introDir = path.join(previewDir, "intro");
const bodyDir = path.join(previewDir, "body");
const finalCandidateDir = path.join(previewDir, "final");
const introVideo = path.join(introDir, "renders", "intro.mp4");
const bodyVideo = path.join(bodyDir, "renders", "body.mp4");
const bodyVoice = path.join(audioDir, "body-voiceover.mp3");
const sharedIntroVoice = voiceProfile.introPath;
const generatedIntroVoice = path.join(audioDir, "intro-voiceover.generated.wav");
const generatedIntroManifest = path.join(audioDir, "intro-voiceover.generated.json");
let introVoice = sharedIntroVoice;
let introVoiceSource = "shared-template";
let generatedAudioPairIsCurrent = false;
if (fs.existsSync(generatedIntroManifest)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(generatedIntroManifest, "utf8"));
    const scriptAndBodyMatch = manifest.scriptVersion === scriptVersion
      && isFileFingerprintCurrent(scriptPath, manifest.scriptFingerprint)
      && isFileFingerprintCurrent(bodyVoice, manifest.bodyVoiceFingerprint);
    if (scriptAndBodyMatch) {
      if (manifest.voiceSource === "tts" && manifest.voiceProfile !== voiceProfile.id) {
        throw new WorkflowError(
          `Generated voiceover uses profile "${manifest.voiceProfile || "unknown"}" but the episode selects "${voiceProfile.id}". Generate a new body-voiceover.raw.mp3 with the selected profile's reference, then rerun finalize-generated-voiceover.mjs before rendering.`,
          { code: "generated_voice_profile_mismatch" },
        );
      }
      if (!isFileFingerprintCurrent(generatedIntroVoice, manifest.generatedIntroFingerprint)) {
        throw new WorkflowError("The generated intro audio no longer matches its manifest.", {
          code: "generated_intro_artifact_stale",
        });
      }
      const standardDuration = Number(probeMedia(sharedIntroVoice).format?.duration || 0);
      const generatedDuration = Number(probeMedia(generatedIntroVoice).format?.duration || 0);
      if (Math.abs(generatedDuration - standardDuration) > 1 / 48000) {
        throw new WorkflowError(
          `Generated intro duration ${generatedDuration.toFixed(3)}s does not match the standard ${standardDuration.toFixed(3)}s.`,
          { code: "generated_intro_duration_mismatch" },
        );
      }
      introVoice = generatedIntroVoice;
      introVoiceSource = "generated-cloned-greeting";
      generatedAudioPairIsCurrent = true;
    }
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    console.warn(`Ignoring stale generated intro metadata: ${error.message}`);
  }
}
// Measure the actual intro voiceover so body captions start exactly when the
// body speech starts (fixes the book-title outro overlapping caption 1).
{
  const measured = Number(probeMedia(introVoice).format?.duration || 0);
  if (Number.isFinite(measured) && measured > 0) {
    introTrimSeconds = measured;
    introOffsetMs = Math.round(measured * 1000);
  }
}
const introStoryVoice = path.join(previewDir, "audio", "intro-voiceover-story.mp3");
const bodyStoryVoice = path.join(audioDir, "body-voiceover-story.mp3");
const bgmMixSuffix =
  FINAL_BGM_GAIN_DB === 0
    ? "bgm-standard"
    : `bgm-mix-${FINAL_BGM_GAIN_DB > 0 ? "plus" : "minus"}${Math.abs(FINAL_BGM_GAIN_DB)}db`;
const outputPath = path.join(rendersDir, `${slug}-final-${bgmSlug}-story-voice-${bgmMixSuffix}.mp4`);
const candidateOutputPath = path.join(finalCandidateDir, path.basename(outputPath));
const introScrollSfxDuration = Number((INTRO_SCROLL_SFX_END_SECONDS - INTRO_SCROLL_SFX_START_SECONDS).toFixed(2));
const introScrollSfxDelayMs = Math.round(INTRO_SCROLL_SFX_START_SECONDS * 1000);
const introScrollSfxFadeOutStart = Number((introScrollSfxDuration - INTRO_SCROLL_SFX_FADE_OUT_SECONDS).toFixed(2));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: options.stdio || "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new WorkflowError(`${command} failed with status ${result.status ?? "unknown"}`, {
      code: "subprocess_failed",
      details: {
        command,
        args,
        cwd: options.cwd || ROOT,
        status: result.status,
        signal: result.signal,
      },
    });
  }
  return result;
}

function activateFinalRender(candidatePath, destinationPath, report) {
  fs.mkdirSync(rendersDir, { recursive: true });
  const reportPath = path.join(episodeDir, "production-report.json");
  const reportCandidate = `${reportPath}.${process.pid}.candidate`;
  const previousRender = `${destinationPath}.${process.pid}.previous`;
  const previousReport = `${reportPath}.${process.pid}.previous`;
  fs.writeFileSync(reportCandidate, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (fs.existsSync(destinationPath)) fs.renameSync(destinationPath, previousRender);
  if (fs.existsSync(reportPath)) fs.renameSync(reportPath, previousReport);
  try {
    fs.renameSync(candidatePath, destinationPath);
    fs.renameSync(reportCandidate, reportPath);
    completeWorkflowStep(episodeDir, "rendered", {
      enforceDependencies: true,
      quality: "review_required",
    });
    fs.rmSync(previousRender, { force: true });
    fs.rmSync(previousReport, { force: true });
  } catch (error) {
    fs.rmSync(destinationPath, { force: true });
    fs.rmSync(reportPath, { force: true });
    if (fs.existsSync(previousRender)) fs.renameSync(previousRender, destinationPath);
    if (fs.existsSync(previousReport)) fs.renameSync(previousReport, reportPath);
    throw error;
  } finally {
    fs.rmSync(reportCandidate, { force: true });
    if (fs.existsSync(previousRender) && !fs.existsSync(destinationPath)) {
      fs.renameSync(previousRender, destinationPath);
    }
    if (fs.existsSync(previousReport) && !fs.existsSync(reportPath)) {
      fs.renameSync(previousReport, reportPath);
    }
    fs.rmSync(previousRender, { force: true });
    fs.rmSync(previousReport, { force: true });
  }
  for (const entry of fs.readdirSync(rendersDir, { withFileTypes: true })) {
    const entryPath = path.join(rendersDir, entry.name);
    if (entry.isFile() && entryPath !== destinationPath) {
      try {
        fs.rmSync(entryPath, { force: true });
      } catch (error) {
        console.warn(`Could not remove old render ${entryPath}: ${error.message}`);
      }
    }
  }
  return reportPath;
}

function getBgmPath(input) {
  const direct = path.resolve(ROOT, input);
  if (fs.existsSync(direct)) return direct;
  const withExt = input.endsWith(".mp3") ? input : `${input}.mp3`;
  const fromAssets = path.join(ROOT, "assets", "bgm", withExt);
  if (fs.existsSync(fromAssets)) return fromAssets;
  throw new Error(`BGM not found: ${input}`);
}

function probeAudioDuration(filePath) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { cwd: ROOT, encoding: "utf8", shell: false },
  );
  const duration = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine audio duration: ${filePath}`);
  }
  return duration;
}

let timingAlignment = {
  method: "voiceover-duration",
  reason: "body timings were unavailable or stale",
  requiresAgentReview: true,
};

function readBodyDuration() {
  const fallbackDuration = probeAudioDuration(bodyVoice);
  if (!fs.existsSync(timingsPath)) {
    console.warn("Missing body-timings.json; continuing with voiceover duration and script hints");
    return fallbackDuration;
  }
  let timings;
  try {
    timings = JSON.parse(fs.readFileSync(timingsPath, "utf8"));
  } catch (error) {
    console.warn(`Could not read body-timings.json; continuing with voiceover duration: ${error.message}`);
    return fallbackDuration;
  }
  const scriptRows = readCsv(scriptPath).rows
    .filter((row) => row.version === scriptVersion)
    .sort((left, right) => Number(left.order) - Number(right.order));
  const resolved = resolvePreviewBodyTimings(timings, {
    version: scriptVersion,
    scriptPath,
    voicePath: bodyVoice,
    expectedOrders: scriptRows.map((row) => row.order),
    fallbackDuration,
  });
  if (!resolved.accepted) {
    console.warn(resolved.warning || "Ignoring stale body timings; continuing with voiceover duration and script hints");
    return fallbackDuration;
  }
  timingAlignment = {
    method: timings.alignment?.method || "unknown",
    reason: timings.alignment?.reason || "",
    requiresAgentReview: timings.alignment?.requiresAgentReview === true,
    asrAvailable: timings.alignment?.asrAvailable === true,
    silenceDetectionAvailable: timings.alignment?.silenceDetectionAvailable !== false,
  };
  if (resolved.warning) console.warn(resolved.warning.replace(/^Body timings need Agent review/u, "Rendering with timings marked for Agent review"));
  const timingDuration = Number(resolved.timings?.duration);
  return Number.isFinite(timingDuration) && timingDuration > 0 ? timingDuration : fallbackDuration;
}

if (!fs.existsSync(introVoice)) {
  throw new Error(`Missing shared intro voiceover: ${introVoice}`);
}
if (!fs.existsSync(bodyVoice)) {
  throw new Error(`Missing episode body voiceover: ${bodyVoice}`);
}
if (!fs.existsSync(INTRO_SCROLL_SFX_PATH)) {
  throw new Error(`Missing intro scroll SFX: ${INTRO_SCROLL_SFX_PATH}`);
}

const bgmPath = getBgmPath(bgmArg);
console.log(`Using BGM: ${path.basename(bgmPath)}`);
const bodyDuration = readBodyDuration();
const finalDuration = Number((introTrimSeconds + bodyDuration).toFixed(2));
if (finalDuration > 60 && !ALLOW_OVER_60_SECONDS) {
  throw new Error(`Planned final duration is ${finalDuration.toFixed(2)}s; maximum is 60s`);
}

fs.mkdirSync(rendersDir, { recursive: true });

run("node", ["scripts/create-episode-preview.mjs", episodeName, scriptVersion]);
fs.mkdirSync(finalCandidateDir, { recursive: true });
run("node", ["scripts/process-voiceover.mjs", introVoice, introStoryVoice, "story"]);
run("node", ["scripts/process-voiceover.mjs", bodyVoice, bodyStoryVoice, "story"]);
run("npx", ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "render", "--quality", "standard", "--output", "renders/intro.mp4"], { cwd: introDir });
run("npx", ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "render", "--quality", "standard", "--output", "renders/body.mp4"], { cwd: bodyDir });

run("ffmpeg", [
  "-y",
  "-i",
  introVideo,
  "-i",
  bodyVideo,
  "-i",
  introStoryVoice,
  "-i",
  bodyStoryVoice,
  "-stream_loop",
  "-1",
  "-i",
  bgmPath,
  "-i",
  INTRO_SCROLL_SFX_PATH,
  "-filter_complex",
  [
    `[0:v]trim=0:${introTrimSeconds},setpts=PTS-STARTPTS[v0]`,
    `[1:v]trim=0:${bodyDuration},setpts=PTS-STARTPTS[v1]`,
    "[v0][v1]concat=n=2:v=1:a=0[v]",
    "[2:a]asetpts=PTS-STARTPTS,aresample=48000,volume=1.0[introa]",
    `[3:a]asetpts=PTS-STARTPTS,aresample=48000,adelay=${introOffsetMs}|${introOffsetMs},volume=1.0[bodya]`,
    `[4:a]atrim=0:${finalDuration},asetpts=PTS-STARTPTS,aresample=48000,volume=${FINAL_BGM_VOLUME}[bgm]`,
    `[5:a]atrim=0:${introScrollSfxDuration},asetpts=PTS-STARTPTS,aresample=48000,volume=${INTRO_SCROLL_SFX_VOLUME},afade=t=in:st=0:d=0.01,afade=t=out:st=${introScrollSfxFadeOutStart}:d=${INTRO_SCROLL_SFX_FADE_OUT_SECONDS},adelay=${introScrollSfxDelayMs}|${introScrollSfxDelayMs}[scrollsfx]`,
    "[introa][bodya][bgm][scrollsfx]amix=inputs=4:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,loudnorm=I=-14.0:TP=-1.0:LRA=7.0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]",
  ].join(";"),
  "-map",
  "[v]",
  "-map",
  "[a]",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-profile:v",
  "high",
  "-level",
  "4.1",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-movflags",
  "+faststart",
  "-shortest",
  candidateOutputPath,
]);

const finalProbe = probeMedia(candidateOutputPath);
const scriptRows = readCsv(scriptPath).rows.filter((row) => row.version === scriptVersion);
let subtitleCount = scriptRows.length;
try {
  const timings = JSON.parse(fs.readFileSync(timingsPath, "utf8"));
  if (Array.isArray(timings.captions) && timings.captions.length > 0) {
    subtitleCount = timings.captions.length;
  }
} catch {}
const requiredImageNames = [
  "result-bridge.png",
  ...getAtmosphereImageNames(scriptRows.filter((row) => Number(row.order) !== 1).length),
];
const report = buildProductionReport({
  book: episodeName,
  scriptVersion,
  bgm: path.basename(bgmPath),
  output: path.join("renders", path.basename(outputPath)),
  probe: finalProbe,
  subtitleCount,
  requiredImages: requiredImageNames.map((name) => ({
    name,
    present: fs.existsSync(path.join(imagesDir, name)),
  })),
  audioInputs: {
    introVoice: fs.existsSync(introVoice),
    bodyVoice: fs.existsSync(bodyVoice),
    bgm: fs.existsSync(bgmPath),
    gearSfx: fs.existsSync(INTRO_SCROLL_SFX_PATH),
  },
  timingAlignment,
  inputArtifacts: {
    bgm: {
      path: path.relative(ROOT, bgmPath),
      fingerprint: fingerprintFile(bgmPath),
    },
    introVoice: {
      source: introVoiceSource,
      path: path.relative(ROOT, introVoice),
    },
  },
  allowOver60Seconds: ALLOW_OVER_60_SECONDS,
});
const reportPath = activateFinalRender(candidateOutputPath, outputPath, report);
fs.rmSync(previewDir, { recursive: true, force: true });
console.log(`Production report: ${reportPath}`);
console.log(outputPath);
