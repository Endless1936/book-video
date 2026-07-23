import fs from "node:fs";
import path from "node:path";

function parseFrameRate(value) {
  const [numerator, denominator = "1"] = String(value || "").split("/");
  const fps = Number(numerator) / Number(denominator);
  return Number.isFinite(fps) ? fps : 0;
}

export function buildProductionReport({
  book,
  scriptVersion,
  bgm,
  output,
  probe,
  subtitleCount,
  requiredImages,
  audioInputs,
  timingAlignment,
  allowOver60Seconds = false,
  now = new Date().toISOString(),
}) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration || 0);
  const fps = parseFrameRate(video?.avg_frame_rate);
  const errors = [];
  if (video?.width !== 720 || video?.height !== 960) errors.push("video must be 720x960");
  if (video?.codec_name !== "h264") errors.push("video codec must be h264");
  if (Math.abs(fps - 30) > 0.01) errors.push("video must be 30fps");
  if (!audio || audio.codec_name !== "aac") errors.push("audio codec must be aac");
  if (!Number.isFinite(duration) || duration <= 0) errors.push("duration must be positive");
  if (!allowOver60Seconds && duration > 60.05) errors.push("duration must be at most 60 seconds");
  if (!Number.isInteger(subtitleCount) || subtitleCount < 1) errors.push("subtitleCount must be positive");
  if (!Array.isArray(requiredImages) || requiredImages.some((item) => item.present !== true)) {
    errors.push("all required images must be present");
  }
  for (const [name, present] of Object.entries(audioInputs || {})) {
    if (present !== true) errors.push(`${name} audio is required`);
  }
  if (errors.length) throw new Error(errors.join("; "));
  return {
    schemaVersion: 1,
    book,
    scriptVersion,
    bgm,
    output,
    technicalChecks: {
      passed: true,
      duration,
      width: video.width,
      height: video.height,
      fps,
      videoCodec: video.codec_name,
      audioCodec: audio.codec_name,
      subtitleCount,
      requiredImages,
      audioInputs,
      timingAlignment,
    },
    agentReview: {
      required: true,
      status: "pending",
      checks: {
        noBlankFrames: null,
        noPlaceholderText: null,
        noSubtitleOverflow: null,
      },
    },
    verified: false,
    generatedAt: now,
  };
}

export function writeProductionReport(episodeDir, report) {
  const destination = path.join(episodeDir, "production-report.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}
