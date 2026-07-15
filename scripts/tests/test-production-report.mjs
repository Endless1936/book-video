import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProductionReport, writeProductionReport } from "../lib/production-report.mjs";

const now = "2026-07-16T00:00:00.000Z";
const report = buildProductionReport({
  book: "我与地坛",
  voice: "自然叙事",
  bgm: "如愿.mp3",
  output: "renders/final.mp4",
  probe: {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 720, height: 960, avg_frame_rate: "30/1" },
      { codec_type: "audio", codec_name: "aac" },
    ],
    format: { duration: "52.40" },
  },
  now,
});

assert.deepEqual(report, {
  schemaVersion: 1,
  book: "我与地坛",
  voice: "自然叙事",
  bgm: "如愿.mp3",
  output: "renders/final.mp4",
  duration: 52.4,
  width: 720,
  height: 960,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  verified: true,
  verifiedAt: now,
});

assert.throws(() => buildProductionReport({
  book: "坏视频",
  voice: "x",
  bgm: "x",
  output: "x.mp4",
  probe: {
    streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" }],
    format: { duration: "61" },
  },
}), /720x960.*audio.*60 seconds/s);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "production-report-"));
try {
  writeProductionReport(root, report);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "production-report.json"), "utf8")), report);
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("production report tests: ok");
