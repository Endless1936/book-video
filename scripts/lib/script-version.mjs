import fs from "node:fs";
import path from "node:path";

export function resolveScriptVersion(episodeDir, requestedVersion = "") {
  if (requestedVersion) return requestedVersion;

  const briefPath = path.join(episodeDir, "brief.json");
  if (fs.existsSync(briefPath)) {
    const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
    if (brief.scriptVersion) return String(brief.scriptVersion);
  }

  const scriptPath = path.join(episodeDir, "script.csv");
  if (fs.existsSync(scriptPath)) {
    const versions = new Set(
      fs.readFileSync(scriptPath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .slice(1)
        .filter(Boolean)
        .map((line) => line.split(",", 1)[0].replace(/^"|"$/gu, ""))
        .filter(Boolean),
    );
    if (versions.size === 1) return [...versions][0];
  }

  return "A_reference_like";
}
