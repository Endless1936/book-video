import fs from "node:fs";
import path from "node:path";

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(target) : [target];
    });
}

export function discoverScriptFiles(root = process.cwd()) {
  return walk(path.join(root, "scripts"))
    .filter((filePath) => filePath.endsWith(".mjs"))
    .map((filePath) => path.relative(root, filePath).split(path.sep).join("/"));
}

export function discoverTestFiles(root = process.cwd()) {
  return discoverScriptFiles(root)
    .filter((filePath) => /^scripts\/tests\/test-.*\.mjs$/u.test(filePath));
}
