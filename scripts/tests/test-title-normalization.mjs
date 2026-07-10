import assert from "node:assert/strict";
import { normalizeDisplayTitle } from "../lib/title-normalization.mjs";

assert.equal(normalizeDisplayTitle("某本书：“副标题说明”"), "某本书");
assert.equal(normalizeDisplayTitle("《书名示例》（经典版）"), "书名示例");
assert.equal(normalizeDisplayTitle("长篇小说（2022新版）"), "长篇小说");
assert.equal(normalizeDisplayTitle("短书名"), "短书名");
console.log("title normalization: ok");
