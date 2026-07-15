import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildVoiceoverText, readActiveScript, validateStageArtifacts } from "../lib/production-artifacts.mjs";

const episode = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-artifacts-"));

try {
  fs.writeFileSync(path.join(episode, "brief.json"), JSON.stringify({
    display_title: "我与地坛",
    author: "史铁生",
    scriptVersion: "A",
  }));
  fs.writeFileSync(path.join(episode, "script.csv"), "version,order,text,duration_hint\nA,2,\"有些答案，要交给时间。\",2\nA,1,\"有些路，只能慢慢走。\",2\nB,1,另一版本。,2\n");

  const rows = readActiveScript(episode, "A");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.order), ["1", "2"]);
  assert.equal(buildVoiceoverText({ display_title: "我与地坛" }, rows), "《我与地坛》\n有些路，只能慢慢走。\n有些答案，要交给时间。\n");
  assert.deepEqual(validateStageArtifacts("selected", episode, "A"), []);
  assert.deepEqual(validateStageArtifacts("scripted", episode, "A"), []);
  assert.match(validateStageArtifacts("illustrated", episode, "A")[0], /result-bridge\.png/);

  for (const name of ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"]) {
    fs.mkdirSync(path.join(episode, "images"), { recursive: true });
    fs.writeFileSync(path.join(episode, "images", name), Buffer.alloc(1024));
  }
  assert.deepEqual(validateStageArtifacts("illustrated", episode, "A"), []);

  fs.writeFileSync(path.join(episode, "brief.json"), JSON.stringify({ display_title: "我与地坛", author: "史铁生", scriptVersion: "B" }));
  assert.match(validateStageArtifacts("selected", episode, "A").join("\n"), /scriptVersion.*A/);

  fs.writeFileSync(path.join(episode, "brief.json"), JSON.stringify({ display_title: "我与地坛", scriptVersion: "A" }));
  assert.match(validateStageArtifacts("selected", episode, "A").join("\n"), /author/);

  fs.writeFileSync(path.join(episode, "brief.json"), "{");
  assert.match(validateStageArtifacts("selected", episode, "A").join("\n"), /valid JSON/);
} finally {
  fs.rmSync(episode, { recursive: true, force: true });
}

console.log("production artifact tests: ok");
