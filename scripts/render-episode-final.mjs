#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readCsv } from "./lib/csv.mjs";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { isFileFingerprintCurrent, probeMedia } from "./lib/media-validation.mjs";
import { buildProductionReport, writeProductionReport } from "./lib/production-report.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/render-episode-final.mjs",
  stage: "final_render",
  nextActions: [
    "Inspect the failed command, referenced media, and tmp preview artifacts.",
    "Correct only the failing input or dependency, then rerun the render.",
    "Keep the previous active render until the new candidate passes technical checks.",
    "After a successful render, inspect representative frames and update production-report.json.",
  ],
});
const HYPERFRAMES_VERSION = "0.7.33";
const INTRO_TRIM_SECONDS = 2.38;
const INTRO_OFFSET_MS = Math.round(INTRO_TRIM_SECONDS * 1000);
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

const [episodeName, requestedVersion, bgmInput] = process.argv.slice(2);

if (!episodeName) {
  throw new WorkflowError("Usage: node scripts/render-episode-final.mjs <episode-name> [script-version] [bgm-file-or-name]", {
    code: "invalid_arguments",
  });
}

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
const episodeDir = path.join(ROOT, "episodes", episodeName);
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
const introVoice = path.join(ROOT, "assets", "template-audio", "intro-voiceover.mp3");
const bodyVoice = path.join(audioDir, "body-voiceover.mp3");
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

function activateFinalRender(candidatePath, destinationPath) {
  fs.mkdirSync(rendersDir, { recursive: true });
  fs.renameSync(candidatePath, destinationPath);
  for (const entry of fs.readdirSync(rendersDir, { withFileTypes: true })) {
    const entryPath = path.join(rendersDir, entry.name);
    if (entry.isFile() && entryPath !== destinationPath) fs.rmSync(entryPath, { force: true });
  }
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
  if (timings.scriptVersion && timings.scriptVersion !== scriptVersion) {
    console.warn(`body-timings.json is for ${timings.scriptVersion}; continuing with script hints for ${scriptVersion}`);
    return fallbackDuration;
  }
  if (!isFileFingerprintCurrent(bodyVoice, timings.audioFingerprint)) {
    console.warn("body-timings.json does not match the current voiceover; continuing with voiceover duration and script hints");
    return fallbackDuration;
  }
  timingAlignment = {
    method: timings.alignment?.method || "unknown",
    reason: timings.alignment?.reason || "",
    requiresAgentReview: timings.alignment?.requiresAgentReview === true,
    asrAvailable: timings.alignment?.asrAvailable === true,
    silenceDetectionAvailable: timings.alignment?.silenceDetectionAvailable !== false,
  };
  if (timings.alignment?.requiresAgentReview) {
    console.warn(
      `Rendering with timings marked for Agent review (${timings.alignment.method || "unknown method"}): `
      + `${timings.alignment.reason || "low-confidence ASR alignment"}`,
    );
  }
  const timingDuration = Number(timings.duration);
  return Number.isFinite(timingDuration) && timingDuration > 0 ? timingDuration : fallbackDuration;
}

if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
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
const finalDuration = Number((INTRO_TRIM_SECONDS + bodyDuration).toFixed(2));
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
    `[0:v]trim=0:${INTRO_TRIM_SECONDS},setpts=PTS-STARTPTS[v0]`,
    `[1:v]trim=0:${bodyDuration},setpts=PTS-STARTPTS[v1]`,
    "[v0][v1]concat=n=2:v=1:a=0[v]",
    "[2:a]asetpts=PTS-STARTPTS,aresample=48000,volume=1.0[introa]",
    `[3:a]asetpts=PTS-STARTPTS,aresample=48000,adelay=${INTRO_OFFSET_MS}|${INTRO_OFFSET_MS},volume=1.0[bodya]`,
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
const subtitleCount = readCsv(scriptPath).rows.filter((row) => row.version === scriptVersion).length;
const requiredImageNames = [
  "result-bridge.png",
  "atmosphere-1.png",
  "atmosphere-2.png",
  "atmosphere-3.png",
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
  allowOver60Seconds: ALLOW_OVER_60_SECONDS,
});
const reportPath = writeProductionReport(episodeDir, report);
activateFinalRender(candidateOutputPath, outputPath);
fs.rmSync(previewDir, { recursive: true, force: true });
console.log(`Production report: ${reportPath}`);
console.log(outputPath);
