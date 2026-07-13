#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";

const ROOT = process.cwd();
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
  console.error("Usage: node scripts/render-episode-final.mjs <episode-name> [script-version] [bgm-file-or-name]");
  process.exit(1);
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
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function probeVideo(filePath) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", filePath],
    { cwd: ROOT, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${result.stderr || "unknown error"}`);
  }
  const probe = JSON.parse(result.stdout);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration || 0);
  if (!video || video.width !== 720 || video.height !== 960) {
    throw new Error(`Invalid final video dimensions: ${video?.width || 0}x${video?.height || 0}`);
  }
  if (!audio) throw new Error("Final video has no audio stream");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid final duration: ${duration}`);
  if (duration > 60.05 && !ALLOW_OVER_60_SECONDS) {
    throw new Error(`Final video is ${duration.toFixed(2)}s; maximum is 60s`);
  }
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

function readBodyDuration() {
  const timings = JSON.parse(fs.readFileSync(timingsPath, "utf8"));
  if (timings.scriptVersion && timings.scriptVersion !== scriptVersion) {
    throw new Error(`body-timings.json is for ${timings.scriptVersion}, not ${scriptVersion}`);
  }
  const scriptLines = fs.readFileSync(path.join(episodeDir, "script.csv"), "utf8").trim().split(/\r?\n/u);
  const expectedCaptionCount = scriptLines.slice(1).filter((line) => line.split(",", 1)[0] === scriptVersion).length;
  const actualCaptionCount = Array.isArray(timings.captions) ? timings.captions.length : 0;
  if (expectedCaptionCount === 0 || actualCaptionCount !== expectedCaptionCount) {
    throw new Error(
      `Caption timing is incomplete for ${scriptVersion}: expected ${expectedCaptionCount}, got ${actualCaptionCount}. `
      + "Run create-body-timings.mjs again before rendering.",
    );
  }
  return Number(timings.duration || 0);
}

if (!fs.existsSync(episodeDir)) throw new Error(`Episode not found: ${episodeDir}`);
if (!fs.existsSync(timingsPath)) throw new Error(`Missing timing file: ${timingsPath}`);
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
    "[2:a]aresample=48000,volume=1.0[introa]",
    `[3:a]aresample=48000,adelay=${INTRO_OFFSET_MS}|${INTRO_OFFSET_MS},volume=1.0[bodya]`,
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

probeVideo(candidateOutputPath);
activateFinalRender(candidateOutputPath, outputPath);
fs.rmSync(previewDir, { recursive: true, force: true });
console.log(outputPath);
