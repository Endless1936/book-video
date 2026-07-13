#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { normalizeDisplayTitle } from "./lib/title-normalization.mjs";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const PIPELINE_PATH = path.join(DATA_DIR, "book-pipeline.csv");
const EXAMPLE_PATH = path.join(DATA_DIR, "book-pipeline.example.csv");
const STATE_PATH = path.join(ROOT, ".book-automation-state.json");
const ENV_PATH = path.join(ROOT, ".env");
const WHISPER_MODEL_PATH = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
const HYPERFRAMES_VERSION = "0.7.33";

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", shell: false });
  return result.status === 0;
}

function fileExists(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
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

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function csvRow(values) { return values.map(csvEscape).join(","); }

function readCsv(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u);
  const headers = parseCsvLine(lines.shift() || "");
  return { headers, rows: lines.filter(Boolean).map((line) => Object.fromEntries(headers.map((header, index) => [header, parseCsvLine(line)[index] || ""])))};
}

function writeEnvKey(key) {
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/u) : [];
  const lines = existing.filter((line) => !line.startsWith("WEREAD_API_KEY="));
  if (key) lines.push(`WEREAD_API_KEY=${key}`);
  const tempPath = `${ENV_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${lines.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, ENV_PATH);
}

function envFileHasKey() {
  return fs.existsSync(ENV_PATH) && fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/u).some((line) => /^WEREAD_API_KEY=\S+/u.test(line));
}

function readHidden(prompt) {
  if (!input.isTTY || !input.setRawMode) return Promise.resolve("");
  output.write(prompt);
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk) => {
      const text = String(chunk);
      if (text === "\u0003") { input.setRawMode(false); input.pause(); output.write("\n"); process.exit(130); }
      if (text === "\r" || text === "\n") {
        input.setRawMode(false); input.pause(); input.removeListener("data", onData); output.write("\n"); resolve(value.trim()); return;
      }
      if (text === "\u007f") value = value.slice(0, -1); else value += text;
    };
    input.setRawMode(true); input.resume(); input.setEncoding("utf8"); input.on("data", onData);
  });
}

async function askYesNo(question, fallback = false) {
  if (!input.isTTY) return fallback;
  const rl = createInterface({ input, output });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

function migratePipeline() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PIPELINE_PATH)) { fs.copyFileSync(EXAMPLE_PATH, PIPELINE_PATH); return "created"; }
  const { headers, rows } = readCsv(PIPELINE_PATH);
  if (!headers.length || !headers.includes("title")) return rows.length ? "ready" : "empty";

  const nextHeaders = headers.map((header) => header === "title" ? "source_title" : header === "bookId" ? "source_book_id" : header);
  if (!nextHeaders.includes("display_title")) nextHeaders.splice(2, 0, "display_title");
  if (!nextHeaders.includes("source_channel")) nextHeaders.splice(5, 0, "source_channel");
  const backup = path.join(DATA_DIR, `.book-pipeline-backup-${Date.now()}.csv`);
  fs.copyFileSync(PIPELINE_PATH, backup);
  const migrated = rows.map((row) => {
    const output = { ...row, source_title: row.source_title || row.title || "", source_book_id: row.source_book_id || row.bookId || "" };
    output.display_title = output.display_title || normalizeDisplayTitle(output.source_title);
    output.source_channel = output.source_channel || (output.source_book_id ? "weread" : "unknown");
    delete output.title; delete output.bookId;
    return output;
  });
  fs.writeFileSync(PIPELINE_PATH, `${[csvRow(nextHeaders), ...migrated.map((row) => csvRow(nextHeaders.map((header) => row[header] || "")))].join("\n")}\n`);
  return "migrated";
}

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const wereadEnabled = await askYesNo("是否启用微信读书？");
  if (wereadEnabled && !process.env.WEREAD_API_KEY) {
    const key = await readHidden("请输入微信读书 API Key（输入内容不会显示）：");
    if (key) writeEnvKey(key);
    else if (input.isTTY) console.log("未写入 API Key，将使用公开资料模式。");
  }

  const pipelineStatus = migratePipeline();
  const state = {
    schemaVersion: 1,
    initializedAt: new Date().toISOString(),
    weread: wereadEnabled && (process.env.WEREAD_API_KEY || envFileHasKey()) ? "enabled" : "disabled",
    imageCapability: process.env.CODEX_IMAGE_CAPABILITY || "agent-managed",
  };
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

  const checks = {
    node: nodeMajor >= 22,
    ffmpeg: commandAvailable("ffmpeg"),
    npx: commandAvailable("npx"),
    whisper: commandAvailable("whisper-cli"),
    whisperModel: fileExists(WHISPER_MODEL_PATH),
    whisperModelPath: path.relative(ROOT, WHISPER_MODEL_PATH),
    whisperModelDownload: "node scripts/download-whisper-model.mjs",
    hyperframes: `npx hyperframes@${HYPERFRAMES_VERSION}`,
    platform: `${process.platform}-${os.arch()}`,
  };
  console.log(JSON.stringify({ pipeline: pipelineStatus, checks }, null, 2));
  if (!checks.node || !checks.ffmpeg || !checks.npx) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
