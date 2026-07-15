import fs from "node:fs";
import path from "node:path";

export function buildProductionReport({ book, voice, bgm, output, probe, now = new Date().toISOString() }) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration || 0);
  const fps = video?.avg_frame_rate === "30/1" ? 30 : 0;
  const errors = [];
  if (video?.width !== 720 || video?.height !== 960) errors.push("video must be 720x960");
  if (video?.codec_name !== "h264") errors.push("video codec must be h264");
  if (fps !== 30) errors.push("video must be 30fps");
  if (!audio || audio.codec_name !== "aac") errors.push("audio codec must be aac");
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60.05) errors.push("duration must be at most 60 seconds");
  if (errors.length) throw new Error(errors.join("; "));
  return {
    schemaVersion: 1,
    book,
    voice,
    bgm,
    output,
    duration,
    width: 720,
    height: 960,
    fps,
    videoCodec: "h264",
    audioCodec: "aac",
    verified: true,
    verifiedAt: now,
  };
}

export function writeProductionReport(episodeDir, report) {
  const destination = path.join(episodeDir, "production-report.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
  }
}
