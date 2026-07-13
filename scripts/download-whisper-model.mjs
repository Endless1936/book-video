#!/usr/bin/env node

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_PATH = path.join(ROOT, "assets", "models", "whisper", "ggml-base.bin");
const MIN_BYTES = 100 * 1024 * 1024;

function download(url, destination, redirects = 0) {
  if (redirects > 5) throw new Error("Too many redirects while downloading Whisper model");

  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
        response.resume();
        const nextUrl = response.headers.location;
        if (!nextUrl) reject(new Error("Redirect without Location header"));
        else resolve(download(new URL(nextUrl, url).toString(), destination, redirects + 1));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const tempPath = `${destination}.${process.pid}.tmp`;
      const file = fs.createWriteStream(tempPath);
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (process.stdout.isTTY) {
          process.stdout.write(`\rDownloading ggml-base.bin ${(received / 1024 / 1024).toFixed(1)} MB`);
        }
      });
      response.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          if (received < MIN_BYTES) {
            fs.rmSync(tempPath, { force: true });
            reject(new Error(`Downloaded file is too small: ${received} bytes`));
            return;
          }
          fs.renameSync(tempPath, destination);
          if (process.stdout.isTTY) process.stdout.write("\n");
          resolve();
        });
      });
      file.on("error", (error) => {
        fs.rmSync(tempPath, { force: true });
        reject(error);
      });
    });
    request.on("error", reject);
  });
}

function installLocal(source, destination) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Local model not found: ${source}`);
  if (fs.statSync(source).size < MIN_BYTES) throw new Error(`Local model is too small: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.${process.pid}.tmp`;
  fs.copyFileSync(source, tempPath);
  fs.renameSync(tempPath, destination);
}

function downloadThroughProxy(url, destination, proxy) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.${process.pid}.tmp`;
  const result = spawnSync("curl", [
    "--fail", "--location", "--retry", "2", "--connect-timeout", "20",
    "--proxy", proxy, "--output", tempPath, url,
  ], { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    fs.rmSync(tempPath, { force: true });
    throw new Error(`Proxy download failed with status ${result.status ?? "unknown"}`);
  }
  if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size < MIN_BYTES) {
    fs.rmSync(tempPath, { force: true });
    throw new Error("Proxy download produced an incomplete Whisper model");
  }
  fs.renameSync(tempPath, destination);
}

function parseArgs(values) {
  const result = { localPath: "", proxy: "" };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--from") result.localPath = values[++index] || "";
    else if (values[index] === "--proxy") result.proxy = values[++index] || "";
  }
  return result;
}

const { localPath, proxy } = parseArgs(process.argv.slice(2));

try {
  if (localPath) {
    installLocal(path.resolve(localPath), MODEL_PATH);
    console.log(`Whisper model installed: ${MODEL_PATH}`);
  } else if (fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size >= MIN_BYTES) {
    console.log(`Whisper model already exists: ${MODEL_PATH}`);
  } else {
    if (proxy) downloadThroughProxy(MODEL_URL, MODEL_PATH, proxy);
    else await download(MODEL_URL, MODEL_PATH);
    console.log(`Whisper model saved: ${MODEL_PATH}`);
  }
} catch (error) {
  console.error(`Whisper model setup failed: ${error.message}`);
  console.error(`Browser download: ${MODEL_URL}`);
  console.error("After downloading, tell the agent the local file path so it can run: node scripts/download-whisper-model.mjs --from <path>");
  process.exitCode = 1;
}
