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
