import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { csvEscape, csvRow, parseCsvLine, readCsv } from "../lib/csv.mjs";

assert.deepEqual(parseCsvLine('A,1,"一句里,有逗号","他说""慢一点"""'), [
  "A",
  "1",
  "一句里,有逗号",
  '他说"慢一点"',
]);
assert.equal(csvEscape('一句里,有逗号'), '"一句里,有逗号"');
assert.equal(csvRow(["A", "1", '他说"慢一点"']), 'A,1,"他说""慢一点"""');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "book-video-csv-"));
try {
  const file = path.join(directory, "script.csv");
  fs.writeFileSync(file, 'version,order,text\n"A,1",1,"一句里,有逗号\n而且有换行"\n');
  assert.deepEqual(readCsv(file), {
    headers: ["version", "order", "text"],
    rows: [{ version: "A,1", order: "1", text: "一句里,有逗号\n而且有换行" }],
  });
  assert.throws(() => parseCsvLine('"未闭合'), /unterminated quoted field/u);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("csv tests: ok");
