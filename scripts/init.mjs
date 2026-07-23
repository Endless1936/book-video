#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { normalizeDisplayTitle } from "./lib/title-normalization.mjs";
import { readEnvValue } from "./lib/env.mjs";
import { csvRow, readCsv } from "./lib/csv.mjs";
import {
  WorkflowError,
  clearWorkflowDiagnostic,
  reportWorkflowFailure,
} from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const PIPELINE_PATH = path.join(DATA_DIR, "book-pipeline.csv");
const EXAMPLE_PATH = path.join(DATA_DIR, "book-pipeline.example.csv");
const STATE_PATH = path.join(ROOT, ".book-automation-state.json");
const ENV_PATH = path.join(ROOT, ".env");
const WHISPER_MODEL_PATH = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
const MIN_WHISPER_MODEL_BYTES = 100 * 1024 * 1024;
const HYPERFRAMES_VERSION = "0.7.33";
const WEREAD_SKILLS_URL = "https://weread.qq.com/r/weread-skills";

function commandAvailable(command) {
  const args = command === "ffmpeg" ? ["-hide_banner", "-h"] : command === "ffprobe" ? ["-version"] : ["--version"];
  const result = spawnSync(command, args, { stdio: "ignore", shell: false });
  return result.status === 0;
}

function fileExists(filePath, minimumBytes = 0) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  return stat.isFile() && stat.size >= minimumBytes;
}

function writeEnvKey(key) {
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/u) : [];
  const lines = existing.filter((line) => !/^\s*(?:export\s+)?WEREAD_API_KEY\s*=/u.test(line));
  if (key) lines.push(`WEREAD_API_KEY=${key}`);
  const tempPath = `${ENV_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${lines.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, ENV_PATH);
}

function getWereadApiKey() {
  return process.env.WEREAD_API_KEY || readEnvValue("WEREAD_API_KEY", ENV_PATH);
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
  clearWorkflowDiagnostic(ROOT);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  let previousState = null;
  if (fs.existsSync(STATE_PATH)) {
    try { previousState = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { previousState = null; }
  }
  let wereadConfigured = Boolean(getWereadApiKey());
  if (!wereadConfigured) {
    console.log(`请打开微信读书 Skills 官网获取 API Key：${WEREAD_SKILLS_URL}`);
    const key = await readHidden("请输入微信读书 API Key（输入内容不会显示）：");
    if (key) writeEnvKey(key);
    else if (input.isTTY) console.log("未配置 API Key，将使用公开资料模式。");
  }
  wereadConfigured = Boolean(getWereadApiKey());

  const pipelineStatus = migratePipeline();
  const state = {
    schemaVersion: 1,
    initializedAt: previousState?.initializedAt || new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    weread: wereadConfigured ? "enabled" : "not_configured",
    imageCapability: process.env.CODEX_IMAGE_CAPABILITY || "agent-managed",
  };
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

  const checks = {
    node: nodeMajor >= 22,
    ffmpeg: commandAvailable("ffmpeg"),
    ffprobe: commandAvailable("ffprobe"),
    npx: commandAvailable("npx"),
    whisper: commandAvailable("whisper-cli"),
    whisperModel: fileExists(WHISPER_MODEL_PATH, MIN_WHISPER_MODEL_BYTES),
    whisperModelBytes: fs.existsSync(WHISPER_MODEL_PATH) ? fs.statSync(WHISPER_MODEL_PATH).size : 0,
    whisperModelPath: path.relative(ROOT, WHISPER_MODEL_PATH),
    whisperModelDownload: "node scripts/download-whisper-model.mjs",
    hyperframes: `npx hyperframes@${HYPERFRAMES_VERSION}`,
    wereadApiKey: wereadConfigured,
    wereadApiKeySource: process.env.WEREAD_API_KEY ? "process-env" : wereadConfigured ? "repo-env" : "none",
    platform: `${process.platform}-${os.arch()}`,
  };
  console.log(JSON.stringify({ pipeline: pipelineStatus, checks }, null, 2));
  const missing = Object.entries({
    "Node.js 22+": checks.node,
    ffmpeg: checks.ffmpeg,
    ffprobe: checks.ffprobe,
    npx: checks.npx,
  }).filter(([, available]) => !available).map(([name]) => name);
  if (missing.length) {
    throw new WorkflowError(`Missing required runtime prerequisites: ${missing.join(", ")}`, {
      code: "missing_runtime_prerequisites",
      nextActions: [
        "Install the complete missing prerequisite list after user confirmation.",
        "Rerun node scripts/init.mjs and continue from the existing local state.",
      ],
      details: { missing },
    });
  }
}

main().catch((error) => reportWorkflowFailure(error, {
  root: ROOT,
  command: "node scripts/init.mjs",
  stage: "initialization",
}));
