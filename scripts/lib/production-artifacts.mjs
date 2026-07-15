import fs from "node:fs";
import path from "node:path";
import { validateBodyScript } from "./script-policy.mjs";

const STAGES_WITH_BRIEF = ["selected", "researched", "scripted", "illustrated", "voiced", "timed", "rendered", "verified"];
const STAGES_WITH_SCRIPT = ["scripted", "illustrated", "voiced", "timed", "rendered", "verified"];
const STAGES_WITH_IMAGES = ["illustrated", "voiced", "timed", "rendered", "verified"];
const STAGES_WITH_AUDIO = ["voiced", "timed", "rendered", "verified"];
const STAGES_WITH_TIMINGS = ["timed", "rendered", "verified"];

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
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

export function validateStageArtifacts(stage, episodeDir, version) {
  const errors = [];
  const requireFile = (relative, minimumBytes = 1) => {
    const file = path.join(episodeDir, relative);
    if (!fs.existsSync(file) || fs.statSync(file).size < minimumBytes) {
      errors.push(`Missing or invalid ${relative}`);
      return false;
    }
    return true;
  };

  if (STAGES_WITH_BRIEF.includes(stage)) requireFile("brief.json");
  if (STAGES_WITH_SCRIPT.includes(stage)) {
    if (requireFile("script.csv")) {
      const rows = readActiveScript(episodeDir, version);
      if (!rows.length) errors.push(`script.csv has no rows for version ${version}`);
      else errors.push(...validateBodyScript(rows).errors);
    }
  }
  if (STAGES_WITH_IMAGES.includes(stage)) {
    for (const name of ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"]) {
      requireFile(`images/${name}`, 1024);
    }
  }
  if (STAGES_WITH_AUDIO.includes(stage)) requireFile("audio/body-voiceover.mp3", 1024);
  if (STAGES_WITH_TIMINGS.includes(stage)) requireFile("audio/body-timings.json");
  return errors;
}
