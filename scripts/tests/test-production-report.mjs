import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProductionReport, writeProductionReport } from "../lib/production-report.mjs";

const input = {
  book: "我与地坛",
  scriptVersion: "A",
  bgm: "如愿.mp3",
  output: "renders/final.mp4",
  subtitleCount: 18,
  requiredImages: ["result-bridge.png", "atmosphere-1.png"].map((name) => ({ name, present: true })),
  audioInputs: { introVoice: true, bodyVoice: true, bgm: true, gearSfx: true },
  timingAlignment: { method: "silence-segments", requiresAgentReview: false },
  probe: {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 720, height: 960, avg_frame_rate: "30/1" },
      { codec_type: "audio", codec_name: "aac" },
    ],
    format: { duration: "52.4" },
  },
  now: "2026-07-23T00:00:00.000Z",
};

const report = buildProductionReport(input);
assert.equal(report.technicalChecks.passed, true);
assert.equal(report.agentReview.status, "pending");
assert.equal(report.agentReview.checks.noBlankFrames, null);
assert.equal(report.verified, false);
assert.throws(
  () => buildProductionReport({
    ...input,
    probe: {
      streams: [
        { codec_type: "video", codec_name: "h264", width: 720, height: 960, avg_frame_rate: "24/1" },
        { codec_type: "audio", codec_name: "aac" },
      ],
      format: { duration: "52.4" },
    },
  }),
  /30fps/u,
);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-report-"));
try {
  const destination = writeProductionReport(directory, report);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), report);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("production report tests: ok");
