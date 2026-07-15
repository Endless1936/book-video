# Automatic Book Video Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a resumable, fully automated Agent-driven workflow that accepts a named book, automatic selection request, or batch book list and delivers verified local MP4 files while using Jianying only for text-to-speech.

**Architecture:** A deterministic Node.js state-machine CLI owns local job state, validates artifacts, and emits one structured next action at a time. Codex follows those actions to perform research, image generation, and Jianying UI control, then resumes the CLI; existing scripts remain responsible for script validation, timing, HyperFrames rendering, FFmpeg mixing, and final activation. This separation keeps UI automation replaceable and makes the orchestration testable without launching Jianying.

**Tech Stack:** Node.js 22+ ES modules, built-in `node:assert`, Codex Computer Use for Jianying, Codex image generation, Whisper CLI, FFmpeg/FFprobe, HyperFrames 0.7.33.

## Global Constraints

- Support `book`, `auto`, `batch`, and `resume` entry modes.
- `script.csv` is the only source of truth for voiceover and subtitle text.
- Fully automatic mode skips human approval but never skips machine quality gates.
- Process batch books sequentially; one book failure must not stop later books.
- Persist each completed stage and resume from the first incomplete stage.
- Use exactly these stages: `selected`, `researched`, `scripted`, `illustrated`, `voiced`, `timed`, `rendered`, `verified`.
- Final media must be `720x960`, 30fps, H.264 video plus AAC audio, and no longer than 60 seconds unless explicitly allowed.
- Each episode must contain one result bridge image and three atmosphere images.
- Keep credentials, Jianying account data, generated media, models, and renders out of Git.
- Do not add automatic social publishing or product-link management.
- Direct CLI execution emits structured Agent actions; Codex performs research, image generation, and Jianying UI operations.

---

## File Map

- Create `scripts/lib/production-command.mjs`: parse four CLI modes into normalized job requests.
- Create `scripts/lib/production-state.mjs`: define stages, create state, validate transitions, persist state atomically, and record failures.
- Create `scripts/lib/production-artifacts.mjs`: read the active script, build copy-ready voiceover text, and validate stage artifacts.
- Create `scripts/lib/production-report.mjs`: probe verified media and write the final report.
- Create `scripts/auto-produce.mjs`: create jobs, select the next episode, emit the next Agent action, and continue batch jobs after failures.
- Create `scripts/record-production-stage.mjs`: validate an Agent-produced artifact set and atomically complete or fail one stage.
- Create `scripts/tests/test-production-command.mjs`: command parser tests.
- Create `scripts/tests/test-production-state.mjs`: state transition, atomic persistence, failure, and resume tests.
- Create `scripts/tests/test-production-artifacts.mjs`: script text and artifact validation tests.
- Create `scripts/tests/test-auto-produce.mjs`: end-to-end state-machine tests with fixture artifacts and a fake renderer boundary.
- Modify `scripts/check.mjs`: syntax-check and run all new tests.
- Modify `package.json`: expose `auto` and `test` commands.
- Modify `.gitignore`: ignore `.book-video-config.json`, production state/report files, and UI failure screenshots.
- Modify `AGENTS.md`: define the Agent action loop and Jianying UI protocol.
- Modify `README.md`: document the three natural-language production modes and first-run behavior.

---

### Task 1: Parse and Normalize Production Commands

**Files:**
- Create: `scripts/lib/production-command.mjs`
- Create: `scripts/tests/test-production-command.mjs`

**Interfaces:**
- Consumes: `string[]` equivalent to `process.argv.slice(2)`.
- Produces: `parseProductionCommand(args): { mode: "book" | "auto" | "batch" | "resume", books: string[], theme: string }`.

- [ ] **Step 1: Write the failing parser tests**

```js
import assert from "node:assert/strict";
import { parseProductionCommand } from "../lib/production-command.mjs";

assert.deepEqual(parseProductionCommand(["book", "我与地坛"]), {
  mode: "book", books: ["我与地坛"], theme: "",
});
assert.deepEqual(parseProductionCommand(["auto", "--theme", "孤独与成长"]), {
  mode: "auto", books: [], theme: "孤独与成长",
});
assert.deepEqual(parseProductionCommand(["batch", "活着", "悉达多"]), {
  mode: "batch", books: ["活着", "悉达多"], theme: "",
});
assert.deepEqual(parseProductionCommand(["resume", "我与地坛"]), {
  mode: "resume", books: ["我与地坛"], theme: "",
});
assert.throws(() => parseProductionCommand([]), /Usage:/);
assert.throws(() => parseProductionCommand(["book"]), /requires exactly one book/);
assert.throws(() => parseProductionCommand(["batch"]), /requires at least one book/);
assert.throws(() => parseProductionCommand(["auto", "--theme"]), /requires a value/);
console.log("production command tests: ok");
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `node scripts/tests/test-production-command.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `production-command.mjs`.

- [ ] **Step 3: Implement the minimal parser**

```js
const MODES = new Set(["book", "auto", "batch", "resume"]);

function usage(message = "") {
  const prefix = message ? `${message}. ` : "";
  throw new Error(`${prefix}Usage: auto-produce.mjs book <title> | auto [--theme <theme>] | batch <title...> | resume <title>`);
}

export function parseProductionCommand(args) {
  const [mode, ...rest] = args;
  if (!MODES.has(mode)) usage();
  if (mode === "auto") {
    if (rest.length === 0) return { mode, books: [], theme: "" };
    if (rest[0] !== "--theme") usage("Unknown auto option");
    if (!rest[1] || rest.length !== 2) usage("--theme requires a value");
    return { mode, books: [], theme: rest[1].trim() };
  }
  const books = rest.map((item) => item.trim()).filter(Boolean);
  if ((mode === "book" || mode === "resume") && books.length !== 1) {
    usage(`${mode} requires exactly one book`);
  }
  if (mode === "batch" && books.length === 0) usage("batch requires at least one book");
  return { mode, books, theme: "" };
}
```

- [ ] **Step 4: Run the parser tests**

Run: `node scripts/tests/test-production-command.mjs`

Expected: `production command tests: ok`.

- [ ] **Step 5: Commit the parser**

```bash
git add scripts/lib/production-command.mjs scripts/tests/test-production-command.mjs
git commit -m "feat: parse automatic production modes"
```

---

### Task 2: Add the Persistent Production State Machine

**Files:**
- Create: `scripts/lib/production-state.mjs`
- Create: `scripts/tests/test-production-state.mjs`

**Interfaces:**
- Consumes: episode directory, book title, optional batch ID, target stage, and error details.
- Produces: `STAGES`, `createProductionState()`, `readProductionState()`, `writeProductionState()`, `completeStage()`, `failStage()`, and `nextStage()`.

- [ ] **Step 1: Write failing state tests**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STAGES, completeStage, createProductionState, failStage,
  nextStage, readProductionState, writeProductionState,
} from "../lib/production-state.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-state-"));
const initial = createProductionState({ book: "我与地坛", mode: "book", batchId: "" });
assert.equal(initial.currentStage, null);
assert.equal(nextStage(initial), "selected");
const selected = completeStage(initial, "selected", "2026-07-16T00:00:00.000Z");
assert.equal(selected.currentStage, "selected");
assert.equal(nextStage(selected), "researched");
assert.throws(() => completeStage(selected, "scripted"), /Expected researched/);
const failed = failStage(selected, "researched", new Error("source unavailable"), "2026-07-16T00:01:00.000Z");
assert.equal(failed.failure.stage, "researched");
assert.equal(failed.failure.attempts, 1);
writeProductionState(dir, failed);
assert.deepEqual(readProductionState(dir), failed);
assert.deepEqual(STAGES, ["selected", "researched", "scripted", "illustrated", "voiced", "timed", "rendered", "verified"]);
fs.rmSync(dir, { recursive: true, force: true });
console.log("production state tests: ok");
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node scripts/tests/test-production-state.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement state creation and transitions**

```js
import fs from "node:fs";
import path from "node:path";

export const STAGES = Object.freeze([
  "selected", "researched", "scripted", "illustrated",
  "voiced", "timed", "rendered", "verified",
]);
const STATE_FILE = "production-state.json";

export function createProductionState({ book, mode, batchId = "", now = new Date().toISOString() }) {
  return {
    schemaVersion: 1, book, mode, batchId, currentStage: null,
    activeScriptVersion: "", completedAt: {}, failure: null,
    createdAt: now, updatedAt: now,
  };
}

export function nextStage(state) {
  if (state.currentStage === null) return STAGES[0];
  const index = STAGES.indexOf(state.currentStage);
  if (index < 0) throw new Error(`Unknown current stage: ${state.currentStage}`);
  return STAGES[index + 1] || null;
}

export function completeStage(state, stage, now = new Date().toISOString(), details = {}) {
  const expected = nextStage(state);
  if (stage !== expected) throw new Error(`Expected ${expected}, received ${stage}`);
  return {
    ...state, ...details, currentStage: stage,
    completedAt: { ...state.completedAt, [stage]: now },
    failure: null, updatedAt: now,
  };
}

export function failStage(state, stage, error, now = new Date().toISOString()) {
  const previousAttempts = state.failure?.stage === stage ? state.failure.attempts : 0;
  return {
    ...state,
    failure: { stage, message: error.message, attempts: previousAttempts + 1, failedAt: now },
    updatedAt: now,
  };
}

export function writeProductionState(episodeDir, state) {
  fs.mkdirSync(episodeDir, { recursive: true });
  const destination = path.join(episodeDir, STATE_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

export function readProductionState(episodeDir) {
  return JSON.parse(fs.readFileSync(path.join(episodeDir, STATE_FILE), "utf8"));
}
```

- [ ] **Step 4: Run state tests**

Run: `node scripts/tests/test-production-state.mjs`

Expected: `production state tests: ok`.

- [ ] **Step 5: Commit the state machine**

```bash
git add scripts/lib/production-state.mjs scripts/tests/test-production-state.mjs
git commit -m "feat: persist automatic production state"
```

---

### Task 3: Build Voiceover Text and Validate Stage Artifacts

**Files:**
- Create: `scripts/lib/production-artifacts.mjs`
- Create: `scripts/tests/test-production-artifacts.mjs`

**Interfaces:**
- Consumes: episode directory and script version.
- Produces: `readActiveScript(episodeDir, version)`, `buildVoiceoverText(brief, rows)`, and `validateStageArtifacts(stage, episodeDir, version)`.

- [ ] **Step 1: Write failing artifact tests with a complete episode fixture**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildVoiceoverText, readActiveScript, validateStageArtifacts } from "../lib/production-artifacts.mjs";

const episode = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-artifacts-"));
fs.writeFileSync(path.join(episode, "brief.json"), JSON.stringify({ display_title: "我与地坛", author: "史铁生", scriptVersion: "A" }));
fs.writeFileSync(path.join(episode, "script.csv"), "version,order,text,duration_hint\nA,1,有些路，只能慢慢走。,2\nA,2,有些答案，要交给时间。,2\n");
const rows = readActiveScript(episode, "A");
assert.equal(rows.length, 2);
assert.equal(buildVoiceoverText({ display_title: "我与地坛" }, rows), "《我与地坛》\n有些路，只能慢慢走。\n有些答案，要交给时间。\n");
assert.deepEqual(validateStageArtifacts("scripted", episode, "A"), []);
assert.match(validateStageArtifacts("illustrated", episode, "A")[0], /result-bridge.png/);
for (const name of ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"]) {
  fs.mkdirSync(path.join(episode, "images"), { recursive: true });
  fs.writeFileSync(path.join(episode, "images", name), Buffer.alloc(1024));
}
assert.deepEqual(validateStageArtifacts("illustrated", episode, "A"), []);
fs.rmSync(episode, { recursive: true, force: true });
console.log("production artifact tests: ok");
```

- [ ] **Step 2: Run the artifact tests and verify failure**

Run: `node scripts/tests/test-production-artifacts.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement CSV parsing, voiceover construction, and exact artifact checks**

Implement `production-artifacts.mjs` with these rules:

```js
import fs from "node:fs";
import path from "node:path";
import { validateBodyScript } from "./script-policy.mjs";

function parseCsvLine(line) {
  const values = []; let current = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { current += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { values.push(current); current = ""; }
    else current += char;
  }
  values.push(current); return values;
}

export function readActiveScript(episodeDir, version) {
  const lines = fs.readFileSync(path.join(episodeDir, "script.csv"), "utf8").trim().split(/\r?\n/u);
  const headers = parseCsvLine(lines.shift() || "");
  return lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  }).filter((row) => row.version === version).sort((a, b) => Number(a.order) - Number(b.order));
}

export function buildVoiceoverText(brief, rows) {
  const title = brief.display_title || brief.displayTitle || brief.title;
  if (!title) throw new Error("brief.json is missing display_title");
  return [`《${title}》`, ...rows.map((row) => row.text)].join("\n") + "\n";
}

export function validateStageArtifacts(stage, episodeDir, version) {
  const errors = [];
  const requireFile = (relative, minimumBytes = 1) => {
    const file = path.join(episodeDir, relative);
    if (!fs.existsSync(file) || fs.statSync(file).size < minimumBytes) errors.push(`Missing or invalid ${relative}`);
  };
  if (["researched", "scripted", "illustrated", "voiced", "timed", "rendered", "verified"].includes(stage)) requireFile("brief.json");
  if (["scripted", "illustrated", "voiced", "timed", "rendered", "verified"].includes(stage)) {
    requireFile("script.csv");
    if (!errors.length) errors.push(...validateBodyScript(readActiveScript(episodeDir, version)).errors);
  }
  if (["illustrated", "voiced", "timed", "rendered", "verified"].includes(stage)) {
    for (const name of ["result-bridge.png", "atmosphere-1.png", "atmosphere-2.png", "atmosphere-3.png"]) requireFile(`images/${name}`, 1024);
  }
  if (["voiced", "timed", "rendered", "verified"].includes(stage)) requireFile("audio/body-voiceover.mp3", 1024);
  if (["timed", "rendered", "verified"].includes(stage)) requireFile("audio/body-timings.json");
  return errors;
}
```

- [ ] **Step 4: Run artifact and existing script-policy tests**

Run: `node scripts/tests/test-production-artifacts.mjs && node scripts/tests/test-body-timings.mjs`

Expected: both scripts end in `ok`.

- [ ] **Step 5: Commit artifact validation**

```bash
git add scripts/lib/production-artifacts.mjs scripts/tests/test-production-artifacts.mjs
git commit -m "feat: validate automatic production artifacts"
```

---

### Task 4: Emit Deterministic Agent Actions from the Orchestrator

**Files:**
- Create: `scripts/auto-produce.mjs`
- Create: `scripts/record-production-stage.mjs`
- Create: `scripts/tests/test-auto-produce.mjs`

**Interfaces:**
- Consumes: normalized command plus files under `episodes/` and `data/book-pipeline.csv`.
- Produces one JSON object on stdout: `{ status, book, stage, action, inputs, expectedOutputs }`.
- Records stage outcomes through `node scripts/record-production-stage.mjs <book> <stage> success|failure [message]`.
- Exit code `0`: action emitted or job complete; exit code `1`: invalid input or unrecoverable state.

- [ ] **Step 1: Write a failing CLI integration test**

The test copies only the CLI and library files into a temporary repository, invokes Node with a controlled working directory, and asserts the action sequence:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-auto-"));
fs.mkdirSync(path.join(root, "episodes"), { recursive: true });
const cli = path.resolve("scripts/auto-produce.mjs");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
const first = run("book", "我与地坛");
assert.equal(first.status, 0, first.stderr);
const action = JSON.parse(first.stdout);
assert.equal(action.action, "select_book");
assert.equal(action.book, "我与地坛");
assert.deepEqual(action.expectedOutputs, ["brief.json"]);
const resume = run("resume", "我与地坛");
assert.equal(JSON.parse(resume.stdout).action, "select_book");
fs.rmSync(root, { recursive: true, force: true });
console.log("auto produce tests: ok");
```

- [ ] **Step 2: Run the CLI test and verify failure**

Run: `node scripts/tests/test-auto-produce.mjs`

Expected: FAIL because `scripts/auto-produce.mjs` does not exist.

- [ ] **Step 3: Implement action mapping and single-book creation**

Use this exact mapping in `auto-produce.mjs`:

```js
const ACTIONS = {
  selected: { action: "select_book", expectedOutputs: ["brief.json"] },
  researched: { action: "research_book", expectedOutputs: ["brief.json"] },
  scripted: { action: "write_script", expectedOutputs: ["script.csv"] },
  illustrated: { action: "generate_images", expectedOutputs: [
    "images/result-bridge.png", "images/atmosphere-1.png",
    "images/atmosphere-2.png", "images/atmosphere-3.png",
  ] },
  voiced: { action: "generate_jianying_voiceover", expectedOutputs: ["audio/body-voiceover.mp3"] },
  timed: { action: "run_command", inputs: { command: "node scripts/create-body-timings.mjs <book>" }, expectedOutputs: ["audio/body-timings.json"] },
  rendered: { action: "run_command", inputs: { command: "node scripts/render-episode-final.mjs <book>" }, expectedOutputs: ["renders/*.mp4"] },
  verified: { action: "verify_and_report", expectedOutputs: ["production-report.json"] },
};
```

The CLI must:

1. parse arguments with `parseProductionCommand()`;
2. create `episodes/<book>/production-state.json` when absent;
3. call `nextStage(state)`;
4. emit the action matching `nextStage(state)` without changing the stage;
5. replace `<book>` in `run_command` with the actual display title;
6. write exactly one JSON object to stdout and no progress prose.

For `auto`, emit `select_candidate` with the theme and require the Agent to re-run as `book <selected-title>` after recording candidates. For `batch`, create `.book-video-batches/<timestamp>.json` with ordered books and emit the first incomplete book action. Batch files are local and ignored.

Implement `record-production-stage.mjs` so that it reads the episode state, requires the supplied stage to equal `nextStage(state)`, calls `validateStageArtifacts(stage, episodeDir, activeScriptVersion)` on success, and refuses completion when validation returns errors. On `failure`, require a non-empty message and persist `failStage()`. On success, persist `completeStage()`; when completing `scripted`, resolve and store `activeScriptVersion` from `brief.json` or `script.csv` before artifact validation.

- [ ] **Step 4: Extend the integration test through `scripted`**

Add fixture writes for `brief.json` and `script.csv`, invoke `record-production-stage.mjs` between orchestrator invocations, and assert the next actions are `research_book`, `write_script`, then `generate_images`. Also create a two-book batch where the first state contains a terminal failure and assert the next emitted action targets the second book.

- [ ] **Step 5: Run all state-machine tests**

Run: `node scripts/tests/test-production-command.mjs && node scripts/tests/test-production-state.mjs && node scripts/tests/test-production-artifacts.mjs && node scripts/tests/test-auto-produce.mjs`

Expected: all four scripts end in `ok`.

- [ ] **Step 6: Commit the orchestrator**

```bash
git add scripts/auto-produce.mjs scripts/record-production-stage.mjs scripts/tests/test-auto-produce.mjs
git commit -m "feat: orchestrate resumable book video jobs"
```

---

### Task 5: Generate and Verify the Final Production Report

**Files:**
- Create: `scripts/lib/production-report.mjs`
- Create: `scripts/tests/test-production-report.mjs`
- Modify: `scripts/auto-produce.mjs`

**Interfaces:**
- Consumes: episode directory, active render path, voice name, BGM name, and `ffprobe` JSON.
- Produces: `buildProductionReport(input)` and atomically written `production-report.json`.

- [ ] **Step 1: Write failing report tests**

```js
import assert from "node:assert/strict";
import { buildProductionReport } from "../lib/production-report.mjs";

const report = buildProductionReport({
  book: "我与地坛", voice: "自然叙事", bgm: "如愿.mp3", output: "renders/final.mp4",
  probe: { streams: [
    { codec_type: "video", codec_name: "h264", width: 720, height: 960, avg_frame_rate: "30/1" },
    { codec_type: "audio", codec_name: "aac" },
  ], format: { duration: "52.40" } },
});
assert.equal(report.verified, true);
assert.equal(report.duration, 52.4);
assert.throws(() => buildProductionReport({
  book: "坏视频", voice: "x", bgm: "x", output: "x.mp4",
  probe: { streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" }], format: { duration: "61" } },
}), /720x960.*audio.*60 seconds/s);
console.log("production report tests: ok");
```

- [ ] **Step 2: Run the report test and verify failure**

Run: `node scripts/tests/test-production-report.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exact media checks and atomic report writing**

```js
import fs from "node:fs";
import path from "node:path";

export function buildProductionReport({ book, voice, bgm, output, probe, now = new Date().toISOString() }) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration || 0);
  const fps = video?.avg_frame_rate === "30/1" ? 30 : 0;
  const errors = [];
  if (video?.width !== 720 || video?.height !== 960) errors.push("video must be 720x960");
  if (video?.codec_name !== "h264") errors.push("video codec must be h264");
  if (fps !== 30) errors.push("video must be 30fps");
  if (!audio || audio.codec_name !== "aac") errors.push("audio codec must be aac");
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60.05) errors.push("duration must be at most 60 seconds");
  if (errors.length) throw new Error(errors.join("; "));
  return { schemaVersion: 1, book, voice, bgm, output, duration, width: 720, height: 960, fps, videoCodec: "h264", audioCodec: "aac", verified: true, verifiedAt: now };
}

export function writeProductionReport(episodeDir, report) {
  const destination = path.join(episodeDir, "production-report.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
}
```

- [ ] **Step 4: Connect the `verified` action**

In `auto-produce.mjs`, make `verify_and_report` require Agent-provided local configuration fields `jianyingVoice` and `lastBgm`, locate the only active MP4 under `renders/`, invoke `ffprobe -of json`, call `buildProductionReport()`, write the report, and complete `verified`. If no single render exists, emit a failure JSON without replacing state.

- [ ] **Step 5: Run report and orchestration tests**

Run: `node scripts/tests/test-production-report.mjs && node scripts/tests/test-auto-produce.mjs`

Expected: both scripts end in `ok`.

- [ ] **Step 6: Commit reporting**

```bash
git add scripts/lib/production-report.mjs scripts/tests/test-production-report.mjs scripts/auto-produce.mjs
git commit -m "feat: report verified book video output"
```

---

### Task 6: Define the Codex and Jianying Automation Protocol

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: JSON action emitted by `scripts/auto-produce.mjs`.
- Produces: the exact expected artifact for that stage, followed by a CLI resume invocation.

- [ ] **Step 1: Add local workflow files to `.gitignore`**

Add:

```gitignore
.book-video-config.json
.book-video-batches/
episodes/*/production-state.json
episodes/*/production-report.json
episodes/*/ui-failures/
```

- [ ] **Step 2: Add the Agent action loop to `AGENTS.md`**

Document these non-optional rules:

```text
When the user requests full automatic production, run auto-produce.mjs and parse its JSON action.
Execute exactly one emitted action, then run record-production-stage.mjs <book> <stage> success and run resume.
Continue until status is complete or the retry policy is exhausted. Do not ask for approval between stages.
Use WeChat Reading when configured and public research otherwise.
Use built-in bitmap image generation for generate_images.
Use Computer Use for generate_jianying_voiceover; never attempt to call Computer Use from Node.js.
Build the text pasted into Jianying from buildVoiceoverText(); do not retype or paraphrase it.
Before export, record the task start time. Accept only an MP3 created after that time, at least 1 KB, and with a positive ffprobe duration.
Store the chosen voice in .book-video-config.json. On later runs, reuse it; if absent, select a natural, restrained Mandarin narrative voice and update the config.
On UI failure, save a screenshot under episodes/<book>/ui-failures/, record failStage(), and retry no more than the configured limit.
For batch mode, continue to the next book after a terminal failure and include every result in the summary.
```

- [ ] **Step 3: Add first-run and usage documentation to `README.md`**

Add the three natural-language examples, the four CLI examples, the one-time Jianying voice selection behavior, the resume behavior, and the limitation that standalone CLI emits Agent actions while Codex supplies UI and image capabilities.

- [ ] **Step 4: Inspect the documentation diff for contradictions**

Run: `git diff --check && rg -n "人工确认|剪映|auto-produce|production-state" README.md AGENTS.md .gitignore`

Expected: no whitespace errors; full-auto instructions explicitly override the ordinary script approval gate only for that episode.

- [ ] **Step 5: Commit the protocol documentation**

```bash
git add AGENTS.md README.md .gitignore
git commit -m "docs: define automatic Jianying production protocol"
```

---

### Task 7: Register Tests and Commands in the Repository Check

**Files:**
- Modify: `package.json`
- Modify: `scripts/check.mjs`

**Interfaces:**
- Consumes: all new scripts and test files.
- Produces: `npm run test`, `npm run auto -- ...`, and an expanded `npm run check`.

- [ ] **Step 1: Add package commands**

Change `package.json` scripts to:

```json
{
  "scripts": {
    "auto": "node scripts/auto-produce.mjs",
    "test": "node scripts/tests/test-title-normalization.mjs && node scripts/tests/test-env.mjs && node scripts/tests/test-body-timings.mjs && node scripts/tests/test-production-command.mjs && node scripts/tests/test-production-state.mjs && node scripts/tests/test-production-artifacts.mjs && node scripts/tests/test-production-report.mjs && node scripts/tests/test-auto-produce.mjs",
    "check": "node scripts/check.mjs"
  }
}
```

- [ ] **Step 2: Expand syntax and test lists in `scripts/check.mjs`**

Add these to `scriptFiles`:

```js
"scripts/auto-produce.mjs",
"scripts/record-production-stage.mjs",
"scripts/lib/production-command.mjs",
"scripts/lib/production-state.mjs",
"scripts/lib/production-artifacts.mjs",
"scripts/lib/production-report.mjs",
"scripts/tests/test-production-command.mjs",
"scripts/tests/test-production-state.mjs",
"scripts/tests/test-production-artifacts.mjs",
"scripts/tests/test-production-report.mjs",
"scripts/tests/test-auto-produce.mjs",
```

Replace the three individually named test invocations with one array loop that runs every test listed by the `test` package script and throws with the failing filename and stderr.

- [ ] **Step 3: Run the local unit suite**

Run: `npm run test`

Expected: every test prints an `ok` line and the command exits 0.

- [ ] **Step 4: Run the complete repository check**

Run: `npm run check`

Expected: HyperFrames lint, validate, and inspect pass; final line is `book-video checks: ok`. If package download is blocked, retry the same command with network-capable execution as required by `AGENTS.md`.

- [ ] **Step 5: Commit command registration**

```bash
git add package.json scripts/check.mjs
git commit -m "test: cover automatic production workflow"
```

---

### Task 8: Perform First-Run and Real Jianying Acceptance

**Files:**
- Local only: `.book-video-config.json`
- Local only: `episodes/<acceptance-book>/production-state.json`
- Local only: `episodes/<acceptance-book>/production-report.json`
- Local only: generated `images/`, `audio/`, and `renders/`

**Interfaces:**
- Consumes: installed Jianying session and one acceptance book.
- Produces: a verified final MP4, persisted voice choice, successful resume evidence, and a batch summary.

- [ ] **Step 1: Run initialization and install only approved missing prerequisites**

Run: `node scripts/init.mjs`

Expected: JSON reports Node.js 22+, `npx`, FFmpeg, FFprobe, Whisper CLI, and a Whisper model of at least 100 MB. Current machine does not expose `node`; obtain the user's one-time approval before installing missing system packages, as required by `AGENTS.md`.

- [ ] **Step 2: Run a single real book through every stage**

Run: `npm run auto -- book "我与地坛"`, then follow emitted actions without manual approval until complete.

Expected: `production-state.json.currentStage` is `verified`, the report says `verified: true`, and the MP4 is directly previewable in the conversation.

- [ ] **Step 3: Verify the selected Jianying voice persists**

Inspect `.book-video-config.json` without printing credentials or account data.

Expected: it contains a non-empty `jianyingVoice` and the next book reuses that voice unless Jianying reports it unavailable.

- [ ] **Step 4: Verify interruption and resume**

Start a second book, stop after `illustrated`, then run: `npm run auto -- resume "<second-book>"`.

Expected: the first emitted action is `generate_jianying_voiceover`; research, scripting, and image generation are not repeated.

- [ ] **Step 5: Verify batch failure isolation**

Run: `npm run auto -- batch "<valid-book-1>" "<intentional-invalid-fixture>" "<valid-book-2>"`.

Expected: both valid books reach `verified`; the invalid fixture appears in the batch summary with its failed stage and does not terminate the batch.

- [ ] **Step 6: Run final regression checks**

Run: `npm run test && npm run check && git status --short`

Expected: tests and checks exit 0; only ignored local production artifacts remain outside Git status.

- [ ] **Step 7: Commit any acceptance-driven code corrections**

If acceptance exposed a code defect, first add a regression test, make it fail, apply the minimal fix, rerun `npm run test && npm run check`, then commit only those tracked corrections:

```bash
git add scripts package.json AGENTS.md README.md .gitignore
git commit -m "fix: harden automatic production acceptance"
```

If no tracked correction was required, do not create an empty commit.

---

## Final Verification Checklist

- [ ] `book`, `auto`, `batch`, and `resume` parse correctly.
- [ ] State transitions reject skipped or out-of-order stages.
- [ ] Every state write is atomic and local-only.
- [ ] Voiceover text is generated only from the active `script.csv` version.
- [ ] The Agent, not Node.js, performs Jianying and image-generation actions.
- [ ] UI failures preserve earlier artifacts and have a bounded retry count.
- [ ] Batch failures do not stop subsequent books.
- [ ] Final report rejects wrong dimensions, frame rate, codecs, missing audio, and duration over 60 seconds.
- [ ] A real Jianying run produces a directly previewable MP4.
- [ ] `npm run test` and `npm run check` pass.
