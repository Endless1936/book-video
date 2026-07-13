#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const HYPERFRAMES_VERSION = "0.7.33";
const requiredCommands = ["ffmpeg", "ffprobe", "npx"];
const scriptFiles = [
  "scripts/init.mjs",
  "scripts/download-whisper-model.mjs",
  "scripts/record-book-candidates.mjs",
  "scripts/create-body-timings.mjs",
  "scripts/create-episode-preview.mjs",
  "scripts/process-voiceover.mjs",
  "scripts/render-episode-final.mjs",
  "scripts/lib/body-timings.mjs",
  "scripts/lib/episode-slug.mjs",
  "scripts/lib/script-version.mjs",
  "scripts/lib/title-normalization.mjs",
  "scripts/lib/weread-request.mjs",
  "scripts/tests/test-body-timings.mjs",
  "scripts/tests/test-title-normalization.mjs",
];

function commandArgs(command) {
  if (command === "ffmpeg") return ["-hide_banner", "-h"];
  if (command === "ffprobe") return ["-version"];
  return ["--version"];
}

function run(command, args, cwd = ROOT, options = {}) {
  return spawnSync(command, args, { cwd, encoding: "utf8", shell: false, ...options });
}

function requireCommand(command) {
  const result = run(command, commandArgs(command), ROOT, { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`Missing or unusable required command: ${command}`);
}

for (const command of requiredCommands) requireCommand(command);
for (const file of scriptFiles) {
  const result = run(process.execPath, ["--check", file]);
  if (result.status !== 0) throw new Error(`Syntax check failed: ${file}`);
}

const defaultIntroBooksPath = path.join(ROOT, "templates", "shared-video-template", "intro", "default-book-list.json");
const defaultIntroBooks = JSON.parse(fs.readFileSync(defaultIntroBooksPath, "utf8"));
if (
  !Array.isArray(defaultIntroBooks)
  || defaultIntroBooks.length !== 6
  || defaultIntroBooks.some((book) => !book?.title || !book?.author)
) {
  throw new Error("Default intro book list must contain exactly six books with authors");
}

const test = run(process.execPath, ["scripts/tests/test-title-normalization.mjs"]);
if (test.status !== 0) throw new Error(test.stderr || "Title normalization test failed");
const timingTest = run(process.execPath, ["scripts/tests/test-body-timings.mjs"]);
if (timingTest.status !== 0) throw new Error(timingTest.stderr || "Body timing test failed");

const templateSourceDir = path.join(ROOT, "templates", "shared-video-template", "intro");
const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-hyperframes-check-"));
fs.cpSync(templateSourceDir, templateDir, { recursive: true });
const resultPlaceholder = path.join(templateDir, "media", "pages", "result.png");
const resultSource = path.join(templateDir, "media", "intro-background.jpg");
const resultConversion = run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y", "-i", resultSource, "-frames:v", "1", resultPlaceholder,
]);
if (resultConversion.status !== 0) {
  fs.rmSync(templateDir, { recursive: true, force: true });
  throw new Error("Could not create temporary HyperFrames result placeholder");
}

try {
  for (const command of ["lint", "validate", "inspect"]) {
    const args = ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, command, "--json"];
    if (command === "validate") args.push("--no-contrast");
    if (command === "inspect") args.push("--at", "0.2,0.75,1.2,1.7,2.08,2.25,2.55,3.2,3.8,4.15");
    const result = run("npx", args, templateDir, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`HyperFrames ${command} failed`);
  }
} finally {
  fs.rmSync(templateDir, { recursive: true, force: true });
}

const modelPath = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
if (!fs.existsSync(modelPath)) console.warn("Warning: Whisper model is not installed. Run node scripts/download-whisper-model.mjs before timing voiceover.");
if (run("whisper-cli", ["--version"], ROOT, { stdio: "ignore" }).status !== 0) {
  console.warn("Warning: whisper-cli is not installed. Voiceover timing will not be available until it is installed.");
}
console.log("book-video checks: ok");
