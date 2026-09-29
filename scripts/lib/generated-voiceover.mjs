import fs from "node:fs";
import { normalizeSpeechText } from "./body-timings.mjs";

export const INTRO_VIDEO_TRIM_SECONDS = 2.38;
// Keep this aligned with the first rolling page in intro/index.html.
export const INTRO_PAGE_FLIP_START_SECONDS = 1.08;
export const GENERATED_INTRO_GREETING = "今天分享的是";
export const GENERATED_INTRO_TAIL_SECONDS = 0.12;

export function findLeadingSilence(logText, audioDuration = null) {
  const events = String(logText ?? "").matchAll(/\bsilence_(start|end):\s*(-?(?:\d+\.?\d*|\.\d+))/g);
  let start = null;
  for (const [, kind, rawValue] of events) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (kind === "start") {
      start = value;
      continue;
    }
    if (start !== null) return start < 0.5 ? { start, end: value } : null;
  }
  const duration = Number(audioDuration);
  return start !== null && start < 0.5 && Number.isFinite(duration) && duration > 0
    ? { start, end: duration }
    : null;
}

export function replaceArtifactsTransactionally(
  replacements,
  {
    existsSync = fs.existsSync,
    renameSync = fs.renameSync,
    rmSync = fs.rmSync,
    afterReplace = () => {},
  } = {},
) {
  const backups = replacements.map(({ candidate, destination, backup }) => ({ candidate, destination, backup }));
  const backedUp = [];
  const promoted = [];

  try {
    for (const item of backups) {
      if (existsSync(item.backup)) {
        throw new Error(`Refusing to overwrite an existing recovery backup: ${item.backup}`);
      }
      if (existsSync(item.destination)) {
        renameSync(item.destination, item.backup);
        backedUp.push(item);
      }
    }
    for (const item of backups) {
      renameSync(item.candidate, item.destination);
      promoted.push(item);
    }
    afterReplace();
  } catch (cause) {
    const rollbackFailures = [];
    for (const item of [...promoted].reverse()) {
      try {
        if (existsSync(item.destination)) rmSync(item.destination, { force: true });
      } catch (error) {
        rollbackFailures.push({ path: item.destination, error: error.message });
      }
    }
    for (const item of [...backedUp].reverse()) {
      try {
        if (existsSync(item.destination)) rmSync(item.destination, { force: true });
        renameSync(item.backup, item.destination);
      } catch (error) {
        rollbackFailures.push({ path: item.backup, error: error.message });
      }
    }

    const recoveryPaths = backedUp
      .filter((item) => existsSync(item.backup))
      .map((item) => item.backup);
    if (rollbackFailures.length > 0) {
      const error = new Error(
        `Artifact replacement failed and rollback was incomplete. Preserve and inspect recovery backups: ${recoveryPaths.join(", ") || "none"}.`,
        { cause },
      );
      error.code = "generated_artifact_rollback_incomplete";
      error.details = { rollbackFailures, recoveryPaths };
      throw error;
    }
    throw cause;
  }

  const retainedBackups = [];
  for (const item of backedUp) {
    try {
      rmSync(item.backup, { force: true });
    } catch {
      retainedBackups.push(item.backup);
    }
  }
  return { retainedBackups };
}

function editDistance(leftText, rightText) {
  const left = Array.from(leftText);
  const right = Array.from(rightText);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function splitError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function deriveGeneratedVoiceoverSplit(
  alignment,
  {
    standardIntroDuration,
    rawDuration,
    pageFlipStartSeconds = INTRO_PAGE_FLIP_START_SECONDS,
  } = {},
) {
  const leadIn = alignment?.diagnostics?.detectedLeadIn;
  if (!leadIn || editDistance(normalizeSpeechText(leadIn.text), normalizeSpeechText(GENERATED_INTRO_GREETING)) > 1) {
    throw splitError(
      "generated_greeting_missing",
      `The generated voiceover must begin with “${GENERATED_INTRO_GREETING}” before the first script row.`,
    );
  }
  if (
    !leadIn.tokenOffsetsAvailable
    || !alignment.firstScriptTokenOffsetAvailable
    || !Number.isFinite(leadIn.end)
    || !Number.isFinite(alignment.firstScriptTokenTime)
  ) {
    throw splitError(
      "generated_greeting_timestamps_missing",
      "Whisper token timestamps are required for the greeting end and first book-title character to separate the generated clips safely.",
    );
  }
  if (!Number.isFinite(standardIntroDuration) || standardIntroDuration <= 0) {
    throw splitError("standard_intro_duration_invalid", "The standard intro audio duration is unavailable.");
  }
  if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
    throw splitError("generated_voiceover_duration_invalid", "The generated voiceover duration is unavailable.");
  }
  if (!Number.isFinite(pageFlipStartSeconds) || pageFlipStartSeconds <= 0) {
    throw splitError("intro_page_flip_timing_invalid", "The intro page-flip start time is unavailable.");
  }
  const greetingAudioEnd = leadIn.end + GENERATED_INTRO_TAIL_SECONDS;
  if (greetingAudioEnd > pageFlipStartSeconds - 0.05) {
    throw splitError(
      "generated_greeting_too_long",
      `The cloned greeting tail ends at ${greetingAudioEnd.toFixed(2)}s; it must end at least 0.05s before the page flip starts at ${pageFlipStartSeconds.toFixed(2)}s. Regenerate it shorter so narration is silent during the page flip.`,
    );
  }
  if (alignment.firstScriptTokenTime <= leadIn.end) {
    throw splitError(
      "generated_greeting_not_separable",
      "Whisper could not find a clean time boundary between the greeting and the first book-title row.",
    );
  }

  const bodySourceStart = Math.min(
    alignment.firstScriptTokenTime,
    Math.max(leadIn.end + 0.04, (leadIn.end + alignment.firstScriptTokenTime) / 2),
  );
  const introSourceEnd = Math.min(
    standardIntroDuration,
    leadIn.end + GENERATED_INTRO_TAIL_SECONDS,
    bodySourceStart,
  );
  if (introSourceEnd <= leadIn.end || bodySourceStart >= alignment.firstScriptTokenTime || bodySourceStart >= rawDuration) {
    throw splitError("generated_voiceover_split_invalid", "The greeting and script audio boundaries are not usable.");
  }

  return {
    greetingText: leadIn.text,
    greetingSpeechEnd: leadIn.end,
    introSourceEnd,
    introDuration: standardIntroDuration,
    bodySourceStart,
    titleSpeechStart: alignment.firstScriptTokenTime,
  };
}
