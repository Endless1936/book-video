#!/usr/bin/env node

import fs from "node:fs";
import https from "node:https";
import path from "node:path";

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

if (fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size >= MIN_BYTES) {
  console.log(`Whisper model already exists: ${MODEL_PATH}`);
} else {
  await download(MODEL_URL, MODEL_PATH);
  console.log(`Whisper model saved: ${MODEL_PATH}`);
}
