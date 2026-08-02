#!/usr/bin/env node

import assert from "node:assert/strict";
import { resolveCommandInvocation } from "../lib/command-invocation.mjs";

const npxArgs = ["--yes", "hyperframes@0.7.33", "lint", "--json"];
assert.deepEqual(
  resolveCommandInvocation("npx", npxArgs, {
    platform: "win32",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
  }),
  {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npx", ...npxArgs],
  },
);

assert.deepEqual(
  resolveCommandInvocation("npx", ["--version"], {
    platform: "win32",
    comSpec: "",
  }),
  {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npx", "--version"],
  },
);

assert.deepEqual(
  resolveCommandInvocation("ffmpeg", ["-version"], { platform: "win32" }),
  { command: "ffmpeg", args: ["-version"] },
);

assert.deepEqual(
  resolveCommandInvocation("npx", ["--version"], { platform: "linux" }),
  { command: "npx", args: ["--version"] },
);

console.log("command invocation tests: ok");
