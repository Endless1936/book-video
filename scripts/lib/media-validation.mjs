import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export function fingerprintFile(filePath) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
  };
}

export function isFileFingerprintCurrent(filePath, fingerprint) {
  if (!fingerprint || !fs.existsSync(filePath)) return false;
  const current = fingerprintFile(filePath);
  return current.size === fingerprint.size && current.sha256 === fingerprint.sha256;
}

export function probeMedia(filePath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    filePath,
  ], { encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${result.error?.message || result.stderr?.trim() || "unknown error"}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`ffprobe returned invalid JSON for ${filePath}`);
  }
}

export function validateVoiceoverArtifact(
  filePath,
  { notBefore = "", minimumBytes = 1024, probe = probeMedia } = {},
) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Voiceover not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.size < minimumBytes) throw new Error(`Voiceover is too small to be valid: ${filePath}`);
  if (notBefore) {
    const threshold = Date.parse(notBefore);
    if (!Number.isFinite(threshold)) throw new Error(`Invalid voiceover freshness timestamp: ${notBefore}`);
    if (stat.mtimeMs <= threshold) throw new Error(`Voiceover predates the current export attempt: ${filePath}`);
  }
  const media = probe(filePath);
  const audio = media.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(media.format?.duration || 0);
  if (!audio) throw new Error(`Voiceover has no audio stream: ${filePath}`);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Voiceover duration must be positive: ${filePath}`);
  return { duration, probe: media, fingerprint: fingerprintFile(filePath) };
}
