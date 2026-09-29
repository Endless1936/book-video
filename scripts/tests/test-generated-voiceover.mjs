import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveGeneratedVoiceoverSplit,
  findLeadingSilence,
  replaceArtifactsTransactionally,
} from "../lib/generated-voiceover.mjs";

const alignment = {
  timestampsAvailable: true,
  firstScriptTokenOffsetAvailable: true,
  firstScriptTokenTime: 1.4,
  diagnostics: {
    detectedLeadIn: {
      text: "今天分享的是",
      tokenOffsetsAvailable: true,
      start: 0.1,
      end: 0.85,
    },
  },
};
const split = deriveGeneratedVoiceoverSplit(alignment, {
  standardIntroDuration: 3.024,
  rawDuration: 8,
});
assert.equal(split.introDuration, 3.024);
assert.equal(split.bodySourceStart, 1.125);
assert.ok(split.introSourceEnd <= split.bodySourceStart, "the greeting clip must not contain any title audio");
assert.doesNotThrow(() => deriveGeneratedVoiceoverSplit({
  ...alignment,
  timestampsAvailable: false,
}, { standardIntroDuration: 3.024, rawDuration: 8 }));
assert.throws(() => deriveGeneratedVoiceoverSplit({
  ...alignment,
  firstScriptTokenOffsetAvailable: false,
}, { standardIntroDuration: 3.024, rawDuration: 8 }));
assert.deepEqual(findLeadingSilence(
  "[silencedetect @ 0xabc] silence_start: 0\n[silencedetect @ 0xabc] silence_end: 3.4 | silence_duration: 3.4",
), { start: 0, end: 3.4 });
assert.equal(findLeadingSilence(
  "[silencedetect @ 0xabc] silence_start: 5.1\n[silencedetect @ 0xabc] silence_end: 7.4 | silence_duration: 2.3",
), null, "an internal pause must not be treated as leading silence");
assert.deepEqual(findLeadingSilence("[silencedetect @ 0xabc] silence_start: 0", 4.5), { start: 0, end: 4.5 });
assert.throws(
  () => deriveGeneratedVoiceoverSplit({
    ...alignment,
    diagnostics: { detectedLeadIn: { ...alignment.diagnostics.detectedLeadIn, text: "早上好" } },
  }, { standardIntroDuration: 3.024, rawDuration: 8 }),
  (error) => error.code === "generated_greeting_missing",
);
assert.throws(
  () => deriveGeneratedVoiceoverSplit({
    ...alignment,
    diagnostics: { detectedLeadIn: { ...alignment.diagnostics.detectedLeadIn, end: 2.22 } },
  }, { standardIntroDuration: 3.024, rawDuration: 8 }),
  (error) => error.code === "generated_greeting_too_long",
);
assert.throws(
  () => deriveGeneratedVoiceoverSplit({
    ...alignment,
    diagnostics: { detectedLeadIn: { ...alignment.diagnostics.detectedLeadIn, end: 1.0 } },
  }, { standardIntroDuration: 3.024, rawDuration: 8 }),
  (error) => error.code === "generated_greeting_too_long",
  "the greeting and its tail must finish before the page flip",
);
const safeBoundary = deriveGeneratedVoiceoverSplit({
  ...alignment,
  firstScriptTokenTime: 2.6,
  diagnostics: { detectedLeadIn: { ...alignment.diagnostics.detectedLeadIn, end: 0.9 } },
}, { standardIntroDuration: 3.024, rawDuration: 8 });
assert.equal(safeBoundary.introSourceEnd, 1.02);

const transactionDir = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-artifact-transaction-"));
try {
  const destinationA = path.join(transactionDir, "a.txt");
  const destinationB = path.join(transactionDir, "b.txt");
  const candidateA = path.join(transactionDir, "a.candidate");
  const candidateB = path.join(transactionDir, "b.candidate");
  const backupA = path.join(transactionDir, "a.previous");
  const backupB = path.join(transactionDir, "b.previous");
  fs.writeFileSync(destinationA, "old-a");
  fs.writeFileSync(destinationB, "old-b");
  fs.writeFileSync(candidateA, "new-a");
  fs.writeFileSync(candidateB, "new-b");
  assert.throws(
    () => replaceArtifactsTransactionally([
      { candidate: candidateA, destination: destinationA, backup: backupA },
      { candidate: candidateB, destination: destinationB, backup: backupB },
    ], {
      renameSync(from, to) {
        if (from === candidateB && to === destinationB) throw new Error("injected promotion failure");
        if (from === backupB && to === destinationB) throw new Error("injected restore failure");
        fs.renameSync(from, to);
      },
    }),
    (error) => error.code === "generated_artifact_rollback_incomplete"
      && error.details.recoveryPaths.includes(backupB),
  );
  assert.equal(fs.readFileSync(destinationA, "utf8"), "old-a");
  assert.equal(fs.existsSync(destinationB), false);
  assert.equal(fs.readFileSync(backupB, "utf8"), "old-b", "an unrestored original must remain recoverable");
  assert.equal(fs.existsSync(candidateB), true);

  const destinationC = path.join(transactionDir, "c.txt");
  const destinationD = path.join(transactionDir, "d.txt");
  const candidateC = path.join(transactionDir, "c.candidate");
  const candidateD = path.join(transactionDir, "d.candidate");
  const backupC = path.join(transactionDir, "c.previous");
  const backupD = path.join(transactionDir, "d.previous");
  fs.writeFileSync(destinationC, "old-c");
  fs.writeFileSync(destinationD, "old-d");
  fs.writeFileSync(candidateC, "new-c");
  fs.writeFileSync(candidateD, "new-d");
  assert.throws(
    () => replaceArtifactsTransactionally([
      { candidate: candidateC, destination: destinationC, backup: backupC },
      { candidate: candidateD, destination: destinationD, backup: backupD },
    ], {
      renameSync(from, to) {
        if (from === destinationD && to === backupD) throw new Error("injected backup failure");
        fs.renameSync(from, to);
      },
    }),
    /injected backup failure/u,
  );
  assert.equal(fs.readFileSync(destinationC, "utf8"), "old-c");
  assert.equal(fs.readFileSync(destinationD, "utf8"), "old-d");
  assert.equal(fs.existsSync(backupC), false, "successfully restored backups should no longer be retained");

  const destinationE = path.join(transactionDir, "e.txt");
  const candidateE = path.join(transactionDir, "e.candidate");
  const backupE = path.join(transactionDir, "e.previous");
  fs.writeFileSync(destinationE, "old-e");
  fs.writeFileSync(candidateE, "new-e");
  const committed = replaceArtifactsTransactionally([
    { candidate: candidateE, destination: destinationE, backup: backupE },
  ]);
  assert.equal(fs.readFileSync(destinationE, "utf8"), "new-e");
  assert.equal(fs.existsSync(backupE), false);
  assert.deepEqual(committed.retainedBackups, []);
} finally {
  fs.rmSync(transactionDir, { recursive: true, force: true });
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-generated-intro-"));
try {
  const outputPath = path.join(tempDir, "intro.wav");
  const rendered = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.8",
    "-af", "atrim=start=0:end=0.6,asetpts=PTS-STARTPTS,apad,atrim=duration=3.024,aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo",
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", outputPath,
  ], { encoding: "utf8", shell: false });
  assert.equal(rendered.status, 0, rendered.stderr);
  const probed = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputPath,
  ], { encoding: "utf8", shell: false });
  assert.equal(probed.status, 0, probed.stderr);
  assert.ok(Math.abs(Number(probed.stdout.trim()) - 3.024) <= 1 / 48000);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("generated voiceover split: ok");
