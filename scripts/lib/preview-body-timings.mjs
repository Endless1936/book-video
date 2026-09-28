import { isFileFingerprintCurrent } from "./media-validation.mjs";

const TIMING_DURATION_TOLERANCE_SECONDS = 0.02;

function fallback(fallbackDuration, warning) {
  return {
    accepted: false,
    timings: Number.isFinite(fallbackDuration) && fallbackDuration > 0
      ? { duration: fallbackDuration, byOrder: new Map() }
      : null,
    warning,
  };
}

export function resolvePreviewBodyTimings(raw, {
  version,
  scriptPath,
  voicePath,
  expectedOrders,
  fallbackDuration,
}) {
  if (raw.scriptVersion && raw.scriptVersion !== version) {
    return fallback(fallbackDuration, `Ignoring body timings for ${raw.scriptVersion}; using script duration hints for ${version}`);
  }
  if (!isFileFingerprintCurrent(scriptPath, raw.scriptFingerprint)) {
    return fallback(fallbackDuration, "Ignoring body timings because script.csv changed or has no fingerprint; using script duration hints");
  }
  if (!isFileFingerprintCurrent(voicePath, raw.audioFingerprint)) {
    return fallback(fallbackDuration, "Ignoring body timings because the voiceover changed or has no fingerprint; using script duration hints");
  }
  if (!Number.isFinite(fallbackDuration) || fallbackDuration <= 0) {
    return fallback(fallbackDuration, "Ignoring body timings because the voiceover duration could not be verified; using script duration hints");
  }
  if (!Number.isFinite(raw.duration) || raw.duration <= 0) {
    return fallback(fallbackDuration, "Ignoring body timings because their duration is missing or invalid; using script duration hints");
  }
  if (Math.abs(raw.duration - fallbackDuration) > TIMING_DURATION_TOLERANCE_SECONDS) {
    return fallback(fallbackDuration, "Ignoring body timings because their duration does not match the probed voiceover; using script duration hints");
  }

  const captions = Array.isArray(raw.captions) ? raw.captions : [];
  const orders = expectedOrders.map(Number);
  if (captions.length !== orders.length
    || captions.some((caption, index) => Number(caption.order) !== orders[index])) {
    return fallback(fallbackDuration, "Ignoring body timings because caption rows do not match the current script order; using script duration hints");
  }

  let previous = null;
  for (const caption of captions) {
    if (
      typeof caption.start !== "number"
      || !Number.isFinite(caption.start)
      || caption.start < 0
      || typeof caption.end !== "number"
      || !Number.isFinite(caption.end)
      || caption.end <= caption.start
    ) {
      return fallback(fallbackDuration, "Ignoring body timings because a caption timestamp is missing or invalid; using script duration hints");
    }
    if (
      caption.start > raw.duration + TIMING_DURATION_TOLERANCE_SECONDS
      || caption.end > raw.duration + TIMING_DURATION_TOLERANCE_SECONDS
      || caption.start > fallbackDuration + TIMING_DURATION_TOLERANCE_SECONDS
      || caption.end > fallbackDuration + TIMING_DURATION_TOLERANCE_SECONDS
    ) {
      return fallback(fallbackDuration, "Ignoring body timings because a caption timestamp exceeds the audio duration; using script duration hints");
    }
    if (previous && (caption.start < previous.start || caption.end < previous.end)) {
      return fallback(fallbackDuration, "Ignoring body timings because caption timestamps are out of order; using script duration hints");
    }
    previous = caption;
  }

  const byOrder = new Map(captions.map((item) => [Number(item.order), item]));
  const reviewWarning = raw.alignment?.requiresAgentReview
    ? `Body timings need Agent review (${raw.alignment.method || "unknown method"}): ${raw.alignment.reason || "low-confidence ASR alignment"}`
    : "";
  return {
    accepted: true,
    timings: {
      duration: raw.duration,
      byOrder,
    },
    warning: reviewWarning,
  };
}
