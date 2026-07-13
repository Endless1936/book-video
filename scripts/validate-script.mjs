#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";

const ROOT = process.cwd();
const [episodeName, requestedVersion] = process.argv.slice(2);

if (!episodeName) {
  console.error("Usage: node scripts/validate-script.mjs <episode-name> [script-version]");
  process.exit(1);
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { current += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { values.push(current); current = ""; }
    else current += char;
  }
  values.push(current);
  return values;
}

const episodeDir = path.join(ROOT, "episodes", episodeName);
const scriptPath = path.join(episodeDir, "script.csv");
if (!fs.existsSync(scriptPath)) throw new Error(`Missing script.csv: ${scriptPath}`);
const version = resolveScriptVersion(episodeDir, requestedVersion);
const lines = fs.readFileSync(scriptPath, "utf8").trim().split(/\r?\n/u);
const headers = parseCsvLine(lines.shift() || "");
const rows = lines
  .filter(Boolean)
  .map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  })
  .filter((row) => row.version === version)
  .sort((a, b) => Number(a.order) - Number(b.order));
if (!rows.length) throw new Error(`No script rows found for version ${version}`);

const result = { episode: episodeName, scriptVersion: version, ...validateBodyScript(rows) };
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) {
  console.error(result.errors.join("；"));
  process.exit(1);
}
