#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { slugifyEpisodeName } from "../lib/episode-slug.mjs";
import { resolveScriptVersion } from "../lib/script-version.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const sourceName = args.shift();
let requestedVersion = "";
let bgm = "城南花已开";
let render = false;
let outputDir = "";

for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === "--render") render = true;
  else if (value === "--bgm") bgm = args[++index];
  else if (value.startsWith("--bgm=")) bgm = value.split("=", 2)[1];
  else if (value === "--output") outputDir = args[++index];
  else if (value.startsWith("--output=")) outputDir = value.split("=", 2)[1];
  else if (!requestedVersion) requestedVersion = value;
  else throw new Error(`Unknown argument: ${value}`);
}

if (!sourceName) {
  console.error(
    'Usage: node scripts/tests/smoke-timing-fallback.mjs "<episode>" [script-version] '
    + '[--render] [--bgm "<name>"] [--output <dir>]',
  );
  process.exit(1);
}

const sourceDir = path.join(ROOT, "episodes", sourceName);
if (!fs.existsSync(sourceDir)) throw new Error(`Episode not found: ${sourceDir}`);

const runId = `${process.pid}-${Date.now()}`;
const smokeName = `__timing_smoke_${runId}__`;
const smokeDir = path.join(ROOT, "episodes", smokeName);
const version = resolveScriptVersion(sourceDir, requestedVersion);
const previewDir = path.join(ROOT, "tmp", `preview-${slugifyEpisodeName(smokeName)}`);
const resultsDir = path.resolve(outputDir || path.join(os.tmpdir(), `book-automation-timing-smoke-${runId}`));
const timingPath = path.join(smokeDir, "audio", "body-timings.json");
const scriptPath = path.join(smokeDir, "script.csv");

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed:\n`
      + `${result.stderr || result.stdout || `status ${result.status}`}`,
    );
  }
  return result;
}

function scriptRowCount() {
  return fs.readFileSync(scriptPath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .slice(1)
    .filter((line) => line.split(",", 1)[0] === version)
    .length;
}

function inspectPreview(label) {
  const result = run(process.execPath, ["scripts/create-episode-preview.mjs", smokeName, version]);
  const htmlPath = path.join(previewDir, "body", "index.html");
  assert.ok(fs.existsSync(htmlPath), `${label}: preview HTML was not created`);
  const html = fs.readFileSync(htmlPath, "utf8");
  const captions = [...html.matchAll(
    /revealCaption\("\.c(\d+)",\s*([0-9.]+),\s*([0-9.]+)\);/gu,
  )].map((match) => ({
    order: Number(match[1]),
    start: Number(match[2]),
    end: Number(match[2]) + Number(match[3]),
  }));
  assert.equal(captions.length, scriptRowCount(), `${label}: caption count mismatch`);
  captions.forEach((caption, index) => {
    assert.ok(caption.end > caption.start, `${label}: caption ${caption.order} has invalid duration`);
    if (index > 0) {
      assert.ok(
        caption.start >= captions[index - 1].end - 0.02,
        `${label}: caption ${caption.order} overlaps caption ${captions[index - 1].order}`,
      );
    }
  });
  return `${result.stderr || ""}${result.stdout || ""}`;
}

function renderFinal(label) {
  run(
    process.execPath,
    ["scripts/render-episode-final.mjs", smokeName, version, bgm],
    { stdio: "inherit", encoding: undefined },
  );
  const renderDir = path.join(smokeDir, "renders");
  const finalName = fs.readdirSync(renderDir).find((name) => name.endsWith(".mp4"));
  assert.ok(finalName, `${label}: final MP4 was not created`);
  const destination = path.join(resultsDir, `${label}.mp4`);
  fs.copyFileSync(path.join(renderDir, finalName), destination);
  return destination;
}

fs.mkdirSync(resultsDir, { recursive: true });
fs.cpSync(sourceDir, smokeDir, { recursive: true });

try {
  assert.ok(fs.existsSync(timingPath), `Source episode has no timing file: ${timingPath}`);
  const originalTiming = fs.readFileSync(timingPath, "utf8");

  fs.rmSync(timingPath);
  assert.match(inspectPreview("missing"), /Missing body-timings\.json/u);

  fs.writeFileSync(timingPath, "{broken\n");
  assert.match(inspectPreview("malformed"), /Could not read body-timings\.json/u);

  const stale = JSON.parse(originalTiming);
  stale.scriptVersion = "__stale_version__";
  fs.writeFileSync(timingPath, `${JSON.stringify(stale, null, 2)}\n`);
  assert.match(inspectPreview("stale-version"), /Ignoring body timings/u);

  const partial = JSON.parse(originalTiming);
  assert.ok(partial.captions?.length >= 3, "Source timing file needs at least three captions");
  partial.captions[Math.floor(partial.captions.length / 2)].start = "bad";
  partial.captions[Math.floor(partial.captions.length / 2)].end = null;
  fs.writeFileSync(timingPath, `${JSON.stringify(partial, null, 2)}\n`);
  inspectPreview("partial-invalid");

  if (render) {
    fs.writeFileSync(timingPath, originalTiming);
    renderFinal("normal-timings");
    fs.rmSync(timingPath);
    renderFinal("fallback-timings");
  }

  fs.writeFileSync(
    path.join(resultsDir, "report.json"),
    `${JSON.stringify({
      sourceEpisode: sourceName,
      scriptVersion: version,
      previewScenarios: ["missing", "malformed", "stale-version", "partial-invalid"],
      rendered: render,
      bgm: render ? bgm : null,
    }, null, 2)}\n`,
  );
  console.log(`timing fallback smoke: ok\n${resultsDir}`);
} finally {
  fs.rmSync(smokeDir, { recursive: true, force: true });
  fs.rmSync(previewDir, { recursive: true, force: true });
}
