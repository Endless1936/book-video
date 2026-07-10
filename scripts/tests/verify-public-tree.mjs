import fs from "node:fs";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const allowlist = fs.readFileSync("PUBLIC_FILES.txt", "utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);

function allowed(file) {
  return allowlist.some((entry) => entry.endsWith("/**") ? file.startsWith(entry.slice(0, -2)) : file === entry);
}

const unexpected = tracked.filter((file) => !allowed(file));
if (unexpected.length) {
  console.error(`Unexpected tracked files:\n${unexpected.join("\n")}`);
  process.exit(1);
}

console.log(`public tree: ok (${tracked.length} files)`);
