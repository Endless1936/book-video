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
    cwd: directory,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(fs.readFileSync(output), previous);
  assert.equal(fs.readdirSync(directory).some((name) => name.includes(".tmp.mp3")), false);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

const workflowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-voice-workflow-"));
const linkedRoot = `${workflowRoot}-link`;
try {
  const episodeDir = path.join(workflowRoot, "episodes", "测试书");
  const audioDir = path.join(episodeDir, "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(path.join(episodeDir, "brief.json"), JSON.stringify({
    display_title: "测试书",
    author: "测试作者",
    source_channel: "test",
    edition_status: "confirmed",
    activeScriptVersion: "A",
  }));
  fs.writeFileSync(
    path.join(episodeDir, "script.csv"),
    "version,order,role,text,duration_hint,notes\nA,1,title,《测试书》,2,测试\nA,2,caption,等待批准再继续,2,测试\n",
  );
  fs.writeFileSync(path.join(audioDir, "source.mp3"), "not audio");
  const validation = spawnSync(process.execPath, [
    path.resolve("scripts/validate-script.mjs"),
    "测试书",
    "A",
  ], {
    cwd: workflowRoot,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(validation.status, 0, validation.stderr);
  fs.symlinkSync(workflowRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

  const result = spawnSync(process.execPath, [
    path.resolve("scripts/process-voiceover.mjs"),
    path.join(audioDir, "source.mp3"),
    path.join(linkedRoot, "episodes", "测试书", "audio", "body-voiceover.mp3"),
    "story",
  ], {
    cwd: workflowRoot,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires valid steps: script_approved/u);
  assert.equal(fs.existsSync(path.join(audioDir, "body-voiceover.mp3")), false);
  const state = JSON.parse(fs.readFileSync(path.join(episodeDir, "workflow-state.json"), "utf8"));
  assert.equal(state.steps.voiced.status, "pending");
  assert.equal(state.steps.script_approved.status, "ready");
} finally {
  fs.rmSync(linkedRoot, { recursive: true, force: true });
  fs.rmSync(workflowRoot, { recursive: true, force: true });
}

console.log("voiceover processing tests: ok");
