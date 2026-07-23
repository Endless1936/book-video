import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveScriptVersion } from "../lib/script-version.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-script-version-"));
try {
  fs.writeFileSync(path.join(directory, "script.csv"), 'version,order,text\n"A,quoted",1,"测试\n下一行"\n');
  assert.equal(resolveScriptVersion(directory), "A,quoted");
  fs.writeFileSync(path.join(directory, "brief.json"), JSON.stringify({ activeScriptVersion: "active" }));
  assert.equal(resolveScriptVersion(directory), "active");
  fs.writeFileSync(path.join(directory, "brief.json"), JSON.stringify({ script_version: "snake" }));
  assert.equal(resolveScriptVersion(directory), "snake");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("script version tests: ok");
