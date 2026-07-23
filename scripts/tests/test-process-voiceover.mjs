import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-voice-process-"));
try {
  const input = path.join(directory, "invalid.mp3");
  const output = path.join(directory, "existing.mp3");
  const previous = Buffer.from("previous-valid-output");
  fs.writeFileSync(input, "not audio");
  fs.writeFileSync(output, previous);
  const result = spawnSync(process.execPath, [
    path.resolve("scripts/process-voiceover.mjs"),
    input,
    output,
    "story",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(fs.readFileSync(output), previous);
  assert.equal(fs.readdirSync(directory).some((name) => name.includes(".tmp.mp3")), false);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("voiceover processing tests: ok");
