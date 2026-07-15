import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseCsvLine } from "./csv.mjs";
import { validateBodyScript } from "./script-policy.mjs";

const STAGES_WITH_BRIEF = ["selected", "researched", "scripted", "illustrated", "voiced", "timed", "rendered", "verified"];
const STAGES_WITH_SCRIPT = ["scripted", "illustrated", "voiced", "timed", "rendered", "verified"];
const STAGES_WITH_IMAGES = ["illustrated", "voiced", "timed", "rendered", "verified"];
const STAGES_WITH_AUDIO = ["voiced", "timed", "rendered", "verified"];
const STAGES_WITH_TIMINGS = ["timed", "rendered", "verified"];
const REQUIRED_IMAGES = ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"];

function defaultProbeMedia(file, kind) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", shell: false });
  if (result.status !== 0) return { ok: false, reason: result.error?.message || result.stderr?.trim() || "ffprobe failed" };
  let probe;
  try { probe = JSON.parse(result.stdout); } catch { return { ok: false, reason: "ffprobe returned malformed JSON" }; }
  const stream = probe.streams?.find((entry) => entry.codec_type === kind);
  if (!stream) return { ok: false, reason: `missing ${kind} stream` };
  if (kind === "audio" && !(Number(probe.format?.duration) > 0)) return { ok: false, reason: "audio duration must be positive" };
  if (kind === "video" && (!(Number(stream.width) > 0) || !(Number(stream.height) > 0))) return { ok: false, reason: "image/video dimensions must be positive" };
  return { ok: true, probe };
}

function readBrief(episodeDir, errors) {
  try { return JSON.parse(fs.readFileSync(path.join(episodeDir, "brief.json"), "utf8")); }
  catch (error) { errors.push(`brief.json is malformed JSON: ${error.message}`); return null; }
}

export function validateVoicedArtifact(episodeDir, attemptStartedAt, probeMedia = defaultProbeMedia) {
  const errors = []; const file = path.join(episodeDir, "audio", "body-voiceover.mp3");
  if (!fs.existsSync(file) || fs.statSync(file).size < 1024) return ["Missing or invalid audio/body-voiceover.mp3"];
  if (!attemptStartedAt) errors.push("Missing voiced attempt start timestamp");
  else if (fs.statSync(file).mtimeMs <= Date.parse(attemptStartedAt)) errors.push("body-voiceover.mp3 is stale for this voiced attempt");
  const result = probeMedia(file, "audio"); if (!result.ok) errors.push(`Invalid audio/body-voiceover.mp3: ${result.reason}`);
  return errors;
}

export function validateRenderedArtifact(episodeDir, probeMedia = defaultProbeMedia) {
  const rendersDir = path.join(episodeDir, "renders");
  const renders = fs.existsSync(rendersDir) ? fs.readdirSync(rendersDir).filter((name) => name.toLowerCase().endsWith(".mp4")) : [];
  if (renders.length !== 1) return ["Rendered success requires exactly one MP4 under renders/"];
  const file = path.join(rendersDir, renders[0]);
  if (fs.statSync(file).size === 0) return ["Rendered MP4 must be non-empty"];
  const result = probeMedia(file, "video"); return result.ok ? [] : [`Invalid rendered MP4: ${result.reason}`];
}

export function readActiveScript(episodeDir, version) {
  const lines = fs.readFileSync(path.join(episodeDir, "script.csv"), "utf8").trim().split(/\r?\n/u);
  const headers = parseCsvLine(lines.shift() || "");
  return lines
    .filter(Boolean)
    .map((line) => {
      const values = parseCsvLine(line);
      return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
    })
    .filter((row) => row.version === version)
    .sort((a, b) => Number(a.order) - Number(b.order));
}

export function buildVoiceoverText(brief, rows) {
  const title = brief.display_title || brief.displayTitle || brief.title;
  if (!title) throw new Error("brief.json is missing display_title");
  return [`《${title}》`, ...rows.map((row) => row.text)].join("\n") + "\n";
}

export function validateStageArtifacts(stage, episodeDir, version, { attemptStartedAt = "", probeMedia = defaultProbeMedia } = {}) {
  const errors = [];
  const requireFile = (relative, minimumBytes = 1) => {
    const file = path.join(episodeDir, relative);
    if (!fs.existsSync(file) || fs.statSync(file).size < minimumBytes) {
      errors.push(`Missing or invalid ${relative}`);
      return false;
    }
    return true;
  };

  let brief = null;
  if (STAGES_WITH_BRIEF.includes(stage) && requireFile("brief.json")) {
    brief = readBrief(episodeDir, errors);
    if (brief) {
      if (!String(brief.display_title || brief.displayTitle || "").trim()) errors.push("brief.json requires display title");
      if (!String(brief.author || "").trim()) errors.push("brief.json requires author");
      if (["researched", "scripted", "illustrated", "voiced", "timed", "rendered", "verified"].includes(stage)) {
        if (!String(brief.source_channel || brief.source || brief.provenance || "").trim()) errors.push("brief.json requires source/provenance");
        if (!String(brief.edition_status || brief.edition || brief.version_status || "").trim()) errors.push("brief.json requires confirmed version or explicit edition status");
      }
    }
  }
  if (STAGES_WITH_SCRIPT.includes(stage)) {
    if (requireFile("script.csv")) {
      const rows = readActiveScript(episodeDir, version);
      if (!rows.length) errors.push(`script.csv has no rows for version ${version}`);
      else errors.push(...validateBodyScript(rows).errors);
    }
  }
  if (STAGES_WITH_IMAGES.includes(stage)) {
    if (requireFile("prompts.csv")) {
      const lines = fs.readFileSync(path.join(episodeDir, "prompts.csv"), "utf8").trim().split(/\r?\n/u);
      const headers = parseCsvLine(lines.shift() || "").map((value) => value.trim());
      const nameIndex = headers.indexOf("name"); const promptIndex = headers.indexOf("prompt");
      if (nameIndex < 0 || promptIndex < 0) errors.push("prompts.csv requires name and prompt columns");
      else {
        const counts = new Map(REQUIRED_IMAGES.map((name) => [name, 0]));
        for (const line of lines.filter(Boolean)) {
          const values = parseCsvLine(line); const name = (values[nameIndex] || "").trim(); const prompt = (values[promptIndex] || "").trim();
          if (!counts.has(name)) errors.push(`prompts.csv has unexpected image name: ${name || "<empty>"}`);
          else { counts.set(name, counts.get(name) + 1); if (!prompt) errors.push(`prompts.csv has empty prompt for ${name}`); }
        }
        for (const [name, count] of counts) {
          if (count === 0) errors.push(`prompts.csv missing ${name}`);
          else if (count > 1) errors.push(`prompts.csv duplicate ${name}`);
        }
      }
    }
    const bitmapNames = fs.existsSync(path.join(episodeDir, "images")) ? fs.readdirSync(path.join(episodeDir, "images")).filter((name) => /\.(?:png|jpe?g|webp)$/iu.test(name)) : [];
    for (const name of bitmapNames) if (!REQUIRED_IMAGES.includes(name)) errors.push(`Unexpected image bitmap: ${name}`);
    for (const name of REQUIRED_IMAGES) {
      const relative = `images/${name}`;
      if (requireFile(relative)) {
        const result = probeMedia(path.join(episodeDir, relative), "video");
        if (!result.ok) errors.push(`Invalid ${relative}: ${result.reason}`);
      }
    }
  }
  if (STAGES_WITH_AUDIO.includes(stage)) {
    errors.push(...validateVoicedArtifact(episodeDir, attemptStartedAt, probeMedia));
  }
  if (STAGES_WITH_TIMINGS.includes(stage)) requireFile("audio/body-timings.json");
  if (["rendered", "verified"].includes(stage)) {
    errors.push(...validateRenderedArtifact(episodeDir, probeMedia));
  }
  return errors;
}
