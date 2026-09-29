import fs from "node:fs";

// Shared intro video length (seconds). The intro audio template owns the spoken
// opener; this is only the visual trim used by the renderer.
export const INTRO_VIDEO_TRIM_SECONDS = 2.38;


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
