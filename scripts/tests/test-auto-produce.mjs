import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { slugifyEpisodeName } from "../lib/episode-slug.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-auto-"));
const autoCli = path.resolve("scripts/auto-produce.mjs");
const recordCli = path.resolve("scripts/record-production-stage.mjs");
const run = (cli, ...args) => spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  encoding: "utf8",
});
const action = (...args) => run(autoCli, ...args);
const record = (...args) => run(recordCli, ...args);
const episodeDir = (book) => path.join(root, "episodes", slugifyEpisodeName(book));

function setCurrentStage(book, currentStage) {
  const stateFile = path.join(episodeDir(book), "production-state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, currentStage }, null, 2)}\n`);
}

try {
  fs.mkdirSync(path.join(root, "episodes"), { recursive: true });

  const first = action("book", "我与地坛");
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), {
    status: "action_required",
    book: "我与地坛",
    stage: "selected",
    action: "select_book",
    inputs: {},
    expectedOutputs: ["brief.json"],
  });
  assert.equal(JSON.parse(action("resume", "我与地坛").stdout).action, "select_book");

  const episode = episodeDir("我与地坛");
  const premature = record("我与地坛", "selected", "success");
  assert.equal(premature.status, 1);
  assert.match(premature.stderr, /brief\.json/);

  fs.writeFileSync(path.join(episode, "brief.json"), JSON.stringify({
    display_title: "我与地坛",
    scriptVersion: "A",
  }));
  assert.equal(record("我与地坛", "selected", "success").status, 0);
  assert.equal(JSON.parse(action("resume", "我与地坛").stdout).action, "research_book");
  assert.equal(record("我与地坛", "researched", "success").status, 0);
  assert.equal(JSON.parse(action("resume", "我与地坛").stdout).action, "write_script");

  fs.writeFileSync(path.join(episode, "script.csv"), [
    "version,order,text,duration_hint",
    "A,1,有些路只能慢慢走这是一段足够长的测试文本用于验证脚本内容。,10",
  ].join("\n"));
  const scripted = record("我与地坛", "scripted", "success");
  assert.equal(scripted.status, 0, scripted.stderr);
  assert.equal(JSON.parse(action("resume", "我与地坛").stdout).action, "generate_images");

  for (const book of ["有 空格", "单'引号", "分号;书", "$(touch should-not-run)"]) {
    assert.equal(action("book", book).status, 0);
    setCurrentStage(book, "voiced");
    assert.deepEqual(JSON.parse(action("resume", book).stdout).inputs, {
      executable: "node",
      args: ["scripts/create-body-timings.mjs", book],
    });
    setCurrentStage(book, "timed");
    assert.deepEqual(JSON.parse(action("resume", book).stdout).inputs, {
      executable: "node",
      args: ["scripts/render-episode-final.mjs", book],
    });
  }

  const quotedVersionBook = "版本逗号测试";
  assert.equal(action("book", quotedVersionBook).status, 0);
  const quotedVersionEpisode = episodeDir(quotedVersionBook);
  fs.writeFileSync(path.join(quotedVersionEpisode, "brief.json"), JSON.stringify({
    display_title: quotedVersionBook,
  }));
  assert.equal(record(quotedVersionBook, "selected", "success").status, 0);
  assert.equal(record(quotedVersionBook, "researched", "success").status, 0);
  fs.writeFileSync(path.join(quotedVersionEpisode, "script.csv"), [
    "version,order,text,duration_hint",
    '"A,final",1,有些路只能慢慢走这是一段足够长的测试文本用于验证脚本内容。,10',
  ].join("\n"));
  const quotedVersion = record(quotedVersionBook, "scripted", "success");
  assert.equal(quotedVersion.status, 0, quotedVersion.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(quotedVersionEpisode, "production-state.json"), "utf8")).activeScriptVersion,
    "A,final",
  );

  const wrongStage = record("我与地坛", "voiced", "success");
  assert.equal(wrongStage.status, 1);
  assert.match(wrongStage.stderr, /Expected illustrated/);

  assert.equal(action("book", "活着").status, 0);
  assert.equal(record("活着", "selected", "failure", "终止处理").status, 0);
  const batch = action("batch", "活着", "悉达多");
  assert.equal(batch.status, 0, batch.stderr);
  assert.equal(JSON.parse(batch.stdout).book, "悉达多");

  const auto = action("auto", "--theme", "孤独与成长");
  assert.equal(auto.status, 0, auto.stderr);
  assert.deepEqual(JSON.parse(auto.stdout), {
    status: "action_required",
    book: "",
    stage: "candidate_selection",
    action: "select_candidate",
    inputs: { theme: "孤独与成长", rerunAs: "book <selected-title>" },
    expectedOutputs: ["data/book-pipeline.csv"],
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("auto produce tests: ok");
