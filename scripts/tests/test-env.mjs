import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvValue } from "../lib/env.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-env-test-"));
const filePath = path.join(directory, ".env");
fs.writeFileSync(filePath, "# comment\nexport WEREAD_API_KEY = \"wrk-test-key\"\n");
assert.equal(readEnvValue("WEREAD_API_KEY", filePath), "wrk-test-key");
fs.rmSync(directory, { recursive: true, force: true });
console.log("env tests: ok");
