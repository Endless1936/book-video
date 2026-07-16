import assert from "node:assert/strict";
import {
  buildCaptionTimings,
  buildEstimatedCaptionTimings,
  buildSpeechSegments,
  coalesceSpeechSegments,
  parseSilenceEvents,
} from "../lib/body-timings.mjs";

const events = parseSilenceEvents(`silence_start: 0\nsilence_end: 0.4\nsilence_start: 1.9\nsilence_end: 2.6\nsilence_start: 3.7\nsilence_end: 4.4\nsilence_start: 5.5`);
const segments = buildSpeechSegments(6, events);
assert.deepEqual(segments, [
  { start: 0.4, end: 1.9 },
  { start: 2.6, end: 3.7 },
  { start: 4.4, end: 5.5 },
]);
assert.deepEqual(buildCaptionTimings([1, 2], segments, 1), [
  { order: 1, start: 2.6, end: 3.7 },
  { order: 2, start: 4.4, end: 5.5 },
]);
assert.deepEqual(coalesceSpeechSegments([
  { start: 0.4, end: 1.9 },
  { start: 2.6, end: 3.7 },
  { start: 3.9, end: 4.6 },
], 2), [
  { start: 0.4, end: 1.9 },
  { start: 2.6, end: 4.6 },
]);
assert.throws(() => buildCaptionTimings([1, 2, 3], segments, 1), /Speech segment count mismatch/);
assert.deepEqual(
  buildEstimatedCaptionTimings(
    [
      { order: 1, text: "第一句", duration_hint: "1" },
      { order: 2, text: "第二句", duration_hint: "1" },
    ],
    [{ start: 1, end: 3 }],
    3,
    0,
  ),
  [
    { order: 1, start: 1, end: 2 },
    { order: 2, start: 2, end: 3 },
  ],
);
console.log("body timings: ok");
