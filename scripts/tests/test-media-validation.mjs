import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fingerprintFile,
  isFileFingerprintCurrent,
  validateVoiceoverArtifact,
} from "../lib/media-validation.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-media-"));
try {
  const file = path.join(directory, "voice.mp3");
  fs.writeFileSync(file, Buffer.alloc(2048));
  const probe = () => ({
    streams: [{ codec_type: "audio", codec_name: "mp3" }],
    format: { duration: "12.5" },
  });
  const validated = validateVoiceoverArtifact(file, { notBefore: "2000-01-01T00:00:00Z", probe });
  assert.equal(validated.duration, 12.5);
  assert.deepEqual(validated.fingerprint, fingerprintFile(file));
  assert.equal(isFileFingerprintCurrent(file, validated.fingerprint), true);
  fs.appendFileSync(file, "changed");
  assert.equal(isFileFingerprintCurrent(file, validated.fingerprint), false);
  assert.throws(
    () => validateVoiceoverArtifact(file, { notBefore: "2999-01-01T00:00:00Z", probe }),
    /predates the current export attempt/u,
  );
  assert.throws(
    () => validateVoiceoverArtifact(file, { probe: () => ({ streams: [], format: { duration: "0" } }) }),
    /no audio stream/u,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("media validation tests: ok");
