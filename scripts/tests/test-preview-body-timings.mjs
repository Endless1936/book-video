import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintFile } from "../lib/media-validation.mjs";
import { resolvePreviewBodyTimings } from "../lib/preview-body-timings.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-preview-timings-"));
try {
  const scriptPath = path.join(tempDir, "script.csv");
  const voicePath = path.join(tempDir, "body-voiceover.mp3");
  fs.writeFileSync(scriptPath, "version,order,text\nv1,1,第一句\nv1,2,第二句\n");
  fs.writeFileSync(voicePath, "voice fixture");

  const raw = {
    scriptVersion: "v1",
    scriptFingerprint: fingerprintFile(scriptPath),
    audioFingerprint: fingerprintFile(voicePath),
    duration: 5,
    captions: [
      { order: 1, start: 1.5, end: 2.1 },
      { order: 2, start: 2.2, end: 3.1 },
    ],
  };
  const options = {
    version: "v1",
    scriptPath,
    voicePath,
    expectedOrders: [1, 2],
    fallbackDuration: 5,
  };

  const current = resolvePreviewBodyTimings(raw, options);
  assert.equal(current.accepted, true);
  assert.equal(current.warning, "");
  assert.deepEqual([...current.timings.byOrder.keys()], [1, 2]);

  fs.writeFileSync(scriptPath, "version,order,text\nv1,1,改过的第一句\nv1,2,第二句\n");
  const staleScript = resolvePreviewBodyTimings(raw, options);
  assert.equal(staleScript.accepted, false);
  assert.match(staleScript.warning, /script\.csv changed/u);
  assert.equal(staleScript.timings.duration, options.fallbackDuration);
  assert.equal(staleScript.timings.byOrder.size, 0);

  const updatedFingerprint = fingerprintFile(scriptPath);
  const currentScriptRaw = { ...raw, scriptFingerprint: updatedFingerprint };
  const wrongCount = resolvePreviewBodyTimings({
    ...currentScriptRaw,
    captions: raw.captions.slice(0, 1),
  }, options);
  assert.equal(wrongCount.accepted, false);
  assert.match(wrongCount.warning, /caption rows do not match/u);
  assert.equal(wrongCount.timings.byOrder.size, 0);

  const wrongOrder = resolvePreviewBodyTimings({
    ...currentScriptRaw,
    captions: [raw.captions[1], raw.captions[0]],
  }, options);
  assert.equal(wrongOrder.accepted, false);
  assert.match(wrongOrder.warning, /caption rows do not match/u);
  assert.equal(wrongOrder.timings.byOrder.size, 0);

  const invalidCases = [
    [{ ...currentScriptRaw, duration: Number.NaN }, /duration is missing or invalid/u],
    [{ ...currentScriptRaw, duration: 4.5 }, /duration does not match/u],
    [{
      ...currentScriptRaw,
      captions: [{ order: 1, start: Number.NaN, end: 2 }, currentScriptRaw.captions[1]],
    }, /timestamp is missing or invalid/u],
    [{
      ...currentScriptRaw,
      captions: [{ order: 1, start: 2.1, end: 2.0 }, currentScriptRaw.captions[1]],
    }, /timestamp is missing or invalid/u],
    [{
      ...currentScriptRaw,
      captions: [{ order: 1, start: 2.5, end: 3 }, { order: 2, start: 2, end: 3.5 }],
    }, /timestamps are out of order/u],
    [{
      ...currentScriptRaw,
      captions: [{ order: 1, start: 1, end: 2 }, { order: 2, start: 4.9, end: 5.1 }],
    }, /timestamp exceeds the audio duration/u],
  ];
  for (const [invalid, warningPattern] of invalidCases) {
    const rejected = resolvePreviewBodyTimings(invalid, options);
    assert.equal(rejected.accepted, false);
    assert.match(rejected.warning, warningPattern);
    assert.equal(rejected.timings.duration, options.fallbackDuration);
    assert.equal(rejected.timings.byOrder.size, 0);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("preview body timings: ok");
