import fs from "node:fs";
import path from "node:path";
import { parseCsvLine } from "./csv.mjs";

export function resolveScriptVersion(episodeDir, requestedVersion = "") {
  if (requestedVersion) return requestedVersion;

  const briefPath = path.join(episodeDir, "brief.json");
  if (fs.existsSync(briefPath)) {
    const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
    const version = brief.activeScriptVersion || brief.scriptVersion || brief.script_version;
    if (version) return String(version);
  }

  const scriptPath = path.join(episodeDir, "script.csv");
  if (fs.existsSync(scriptPath)) {
    const versions = new Set(
      fs.readFileSync(scriptPath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .slice(1)
        .filter(Boolean)
        .map((line) => parseCsvLine(line)[0])
        .filter(Boolean),
    );
    if (versions.size === 1) return [...versions][0];
  }

  return "A_reference_like";
}
