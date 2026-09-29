import assert from "node:assert/strict";
import {
  alignScriptToWhisper,
  deriveSkipLeadingSegments,
  flattenWhisperCharacters,
} from "../lib/body-timings.mjs";
import { deriveGeneratedVoiceoverSplit } from "../lib/generated-voiceover.mjs";

function token(text, from, to) {
  return { text, offsets: { from, to } };
}

function asr(transcription) {
  return { transcription };
}

function shiftSegment(segment, milliseconds) {
  return {
    ...segment,
    offsets: { from: segment.offsets.from + milliseconds, to: segment.offsets.to + milliseconds },
    tokens: segment.tokens.map((item) => ({
      ...item,
      offsets: { from: item.offsets.from + milliseconds, to: item.offsets.to + milliseconds },
    })),
  };
}

const rows = [
  { order: 1, text: "你有没有失去过一个重要的人？" },
  { order: 2, text: "后来才发现那时就是最好的时候。" },
];

// Whisper segments need not correspond one-to-one with script rows.
const segmentedAsr = asr([
  { text: "你有没有失去过", offsets: { from: 0, to: 1100 }, tokens: [token("你有没有", 100, 520), token("失去", 520, 850), token("过", 850, 1100)] },
  { text: "一个重要的人后来才发现", offsets: { from: 1200, to: 2500 }, tokens: [token("一个", 1200, 1400), token("重要", 1400, 1750), token("的人，", 1750, 2050), token("后来", 2050, 2300), token("才发现", 2300, 2500)] },
  { text: "那时就是最好的时候", offsets: { from: 2600, to: 3900 }, tokens: [token("那时", 2600, 2850), token("就是", 2850, 3150), token("最好的", 3150, 3500), token("时候。", 3500, 3900)] },
]);
const flattened = flattenWhisperCharacters(segmentedAsr);
assert.equal(flattened.hasTokenTimestamps, true);
assert.equal(flattened.characters[0].start, 0.1);
assert.equal(flattened.characters.at(-1).end, 3.9);

const good = alignScriptToWhisper(rows, segmentedAsr);
assert.equal(good.ok, true);
assert.equal(good.captions.length, rows.length);
assert.deepEqual(good.captions.map((caption) => caption.order), [1, 2]);
assert.ok(good.captions[0].start < good.captions[1].start);
assert.equal(good.captions[0].start, 0.1);
assert.equal(good.captions[1].end, 3.9);

// A single recognition typo is tolerated without changing subtitle text truth.
const typoAsr = asr([
  { text: "你有没有失去过一个重要的人后来才发现那时就是最好的时侯", offsets: { from: 0, to: 4000 }, tokens: [
    token("你有没有失去过一个重要的人后来才发现那时就是最好的时侯", 0, 4000),
  ] },
]);
const typo = alignScriptToWhisper(rows, typoAsr);
assert.equal(typo.ok, true);
assert.equal(typo.diagnostics.substitutions, 1);
assert.equal(typo.diagnostics.requiresAgentReview, true);
assert.equal(typo.diagnostics.contentCheck, "matched_with_asr_variance");
assert.equal(typo.diagnostics.rows[1].recognizedText, "后来才发现那时就是最好的时侯");
assert.ok(typo.diagnostics.rows[1].coverage > 0.9);
assert.equal(typo.diagnostics.rows[1].exact, false);
assert.equal(typo.sequenceMappable, true);
assert.equal("text" in typo.captions[1], false, "Whisper wording must not replace script subtitle text");

// Simplified/traditional conversion can create many character differences while
// preserving a complete row-order map; warn for review rather than blocking timing.
const traditionalRows = [
  { order: "1", text: "书名" },
  { order: "2", text: "发展后书" },
];
const traditionalText = "书名發展後書";
const traditional = alignScriptToWhisper(traditionalRows, asr([
  { text: traditionalText, offsets: { from: 0, to: 1800 }, tokens: [token(traditionalText, 0, 1800)] },
]), { episodeTitle: "书名", audioDuration: 2 });
assert.equal(traditional.contentValid, false);
assert.equal(traditional.sequenceMappable, true);
assert.equal(traditional.ok, false);
assert.equal(traditional.diagnostics.requiresAgentReview, true);
assert.equal(traditional.captions.length, traditionalRows.length);
assert.ok(traditional.captions.every((caption) => Number.isFinite(caption.start) && Number.isFinite(caption.end)));

// A dropped character in a longer row stays useful as a timing clue and is
// surfaced for review while captions remain timing-only.
const omittedText = "你有没有失去过一个重要的人后来发现那时就是最好的时候";
const omitted = alignScriptToWhisper(rows, asr([
  { text: omittedText, offsets: { from: 0, to: 4000 }, tokens: [token(omittedText, 0, 4000)] },
]));
assert.equal(omitted.ok, true);
assert.equal(omitted.diagnostics.rows[1].recognizedText, "后来发现那时就是最好的时候");
assert.equal(omitted.diagnostics.rows[1].editDistance, 1);
assert.equal(omitted.diagnostics.requiresAgentReview, true);
assert.deepEqual(omitted.captions.map((caption) => caption.order), [1, 2]);
assert.equal("text" in omitted.captions[1], false, "omitted ASR wording must not become subtitle text");

const leadInAsr = asr([
  { text: "今天分享的是", offsets: { from: 0, to: 850 }, tokens: [token("今天分享的是", 0, 850)] },
  ...segmentedAsr.transcription.map((segment) => shiftSegment(segment, 950)),
]);
const leadIn = alignScriptToWhisper(rows, leadInAsr, { episodeTitle: "被讨厌的勇气" });
assert.equal(leadIn.ok, true);
assert.equal(leadIn.diagnostics.detectedLeadIn.text, "今天分享的是");
assert.equal(leadIn.captions[0].start, 1.05);
assert.equal(leadIn.firstScriptTokenOffsetAvailable, true);
assert.equal(leadIn.diagnostics.detectedLeadIn.end, 0.85);
assert.equal(deriveSkipLeadingSegments([
  { start: 0, end: 0.85 },
  { start: 0.95, end: 4.9 },
], leadIn).skipLeading, 1);

const titleRows = [
  { order: 1, text: "《被讨厌的勇气》" },
  { order: 2, text: "你有没有失去过一个重要的人" },
];
const partialBodyTime = alignScriptToWhisper(titleRows, asr([
  { text: "今天分享的是", offsets: { from: 0, to: 500 }, tokens: [
    { text: "今天分享的" },
    token("是", 400, 500),
  ] },
  { text: "被讨厌的勇气", offsets: { from: 800, to: 1400 }, tokens: [token("被讨厌的勇气", 800, 1400)] },
  { text: "你有没有失去过一个重要的人", offsets: { from: 1500, to: 3000 }, tokens: [
    { text: "你有没有失去过一个重要的人" },
  ] },
]));
assert.equal(partialBodyTime.timestampsAvailable, false);
assert.equal(partialBodyTime.sequenceMappable, true);
assert.equal(partialBodyTime.firstScriptTokenOffsetAvailable, true);
assert.equal(partialBodyTime.diagnostics.detectedLeadIn.tokenOffsetsAvailable, true);
assert.doesNotThrow(() => deriveGeneratedVoiceoverSplit(partialBodyTime, {
  standardIntroDuration: 3.024,
  rawDuration: 8,
}));

const missingTitleFirstTime = alignScriptToWhisper(titleRows, asr([
  { text: "今天分享的是", offsets: { from: 0, to: 500 }, tokens: [token("今天分享的是", 0, 500)] },
  { text: "被讨厌的勇气", offsets: { from: 800, to: 1400 }, tokens: [
    { text: "被" },
    token("讨厌的勇气", 900, 1400),
  ] },
  { text: "你有没有失去过一个重要的人", offsets: { from: 1500, to: 3000 }, tokens: [token("你有没有失去过一个重要的人", 1500, 3000)] },
]));
assert.equal(missingTitleFirstTime.firstScriptTokenOffsetAvailable, false);
assert.throws(() => deriveGeneratedVoiceoverSplit(missingTitleFirstTime, {
  standardIntroDuration: 3.024,
  rawDuration: 8,
}));

const firstTitleCharacterTypo = alignScriptToWhisper(titleRows, asr([
  { text: "今天分享的是", offsets: { from: 0, to: 500 }, tokens: [token("今天分享的是", 0, 500)] },
  { text: "北讨厌的勇气", offsets: { from: 800, to: 1400 }, tokens: [token("北讨厌的勇气", 800, 1400)] },
  { text: "你有没有失去过一个重要的人", offsets: { from: 1500, to: 3000 }, tokens: [token("你有没有失去过一个重要的人", 1500, 3000)] },
]));
assert.equal(firstTitleCharacterTypo.sequenceMappable, true);
assert.equal(firstTitleCharacterTypo.firstScriptTokenOffsetAvailable, true);
assert.doesNotThrow(() => deriveGeneratedVoiceoverSplit(firstTitleCharacterTypo, {
  standardIntroDuration: 3.024,
  rawDuration: 8,
}));

const greetingAndTitleCombined = "今天分享的是被讨厌的勇气";
const combinedBoundary = alignScriptToWhisper(titleRows, asr([
  { text: greetingAndTitleCombined, offsets: { from: 0, to: 1400 }, tokens: [token(greetingAndTitleCombined, 0, 1400)] },
  { text: "你有没有失去过一个重要的人", offsets: { from: 1500, to: 3000 }, tokens: [token("你有没有失去过一个重要的人", 1500, 3000)] },
]));
assert.equal(combinedBoundary.firstScriptTokenOffsetAvailable, true);
assert.throws(() => deriveGeneratedVoiceoverSplit(combinedBoundary, {
  standardIntroDuration: 3.024,
  rawDuration: 8,
}), (error) => error.code === "generated_greeting_not_separable");

const typoGreetingAsr = asr([
  { text: "今天分享的事", offsets: { from: 0, to: 850 }, tokens: [token("今天分享的事", 0, 850)] },
  { text: "讨厌的勇气", offsets: { from: 1050, to: 2100 }, tokens: [token("讨厌的勇气", 1050, 2100)] },
  { text: "你有没有失去过一个重要的人", offsets: { from: 2350, to: 4300 }, tokens: [token("你有没有失去过一个重要的人", 2350, 4300)] },
]);
const titleAlignment = alignScriptToWhisper(titleRows, typoGreetingAsr, { episodeTitle: "被讨厌的勇气" });
assert.equal(titleAlignment.ok, true, "a likely ASR typo in the known greeting remains alignable");
assert.equal(titleAlignment.captions.length, 2);
assert.equal(titleAlignment.diagnostics.rows[0].role, "title");
assert.ok(titleAlignment.diagnostics.rows[0].coverage >= 0.8, "the title still maps when Whisper drops its first character");
assert.equal(titleAlignment.firstScriptTokenOffsetAvailable, false, "the second title character cannot stand in for the missing first character");
assert.equal(titleAlignment.diagnostics.titleStartAnchorUnavailable, true);
assert.equal(titleAlignment.captions[0].start, 1.05, "the book title is the first aligned script row");
assert.equal(titleAlignment.diagnostics.rows[0].recognizedText, "讨厌的勇气");
assert.throws(() => deriveGeneratedVoiceoverSplit(titleAlignment, {
  standardIntroDuration: 3.024,
  rawDuration: 4.3,
}), (error) => error.code === "generated_greeting_timestamps_missing");

const overlappingIntroRows = [
  { order: 1, text: "今天分享的是一本让我遗憾的书" },
  { order: 2, text: "它说出了很多人的心声" },
];
const overlappingIntroText = `今天分享的是${overlappingIntroRows.map((row) => row.text).join("")}`;
const overlappingIntro = alignScriptToWhisper(overlappingIntroRows, asr([
  { text: overlappingIntroText, offsets: { from: 0, to: 5000 }, tokens: [token(overlappingIntroText, 0, 5000)] },
]), { episodeTitle: "朝花夕拾" });
assert.equal(overlappingIntro.ok, true);
assert.equal(overlappingIntro.diagnostics.detectedLeadIn.text, "今天分享的是");
assert.ok(overlappingIntro.captions[0].start > 0.5);

const wrongTitleAsr = asr([
  { text: "今天分享的是", offsets: { from: 0, to: 850 }, tokens: [token("今天分享的是", 0, 850)] },
  { text: "小王子", offsets: { from: 1050, to: 1700 }, tokens: [token("小王子", 1050, 1700)] },
  { text: "你有没有失去过一个重要的人", offsets: { from: 1900, to: 4300 }, tokens: [token("你有没有失去过一个重要的人", 1900, 4300)] },
]);
const wrongTitle = alignScriptToWhisper(titleRows, wrongTitleAsr, { episodeTitle: "被讨厌的勇气" });
assert.equal(wrongTitle.ok, false, "a different spoken book title must not pass on aggregate row coverage");
assert.ok(wrongTitle.diagnostics.issues.some((issue) => issue.code === "script_title_mismatch"));

const wrongTitleAfterGreetingText = "今天分享的是《小王子》被讨厌的勇气你有没有失去过一个重要的人";
const wrongTitleAfterGreeting = alignScriptToWhisper(titleRows, asr([
  {
    text: wrongTitleAfterGreetingText,
    offsets: { from: 0, to: 6200 },
    tokens: [
      token("今天分享的是", 0, 850),
      token("《小王子》", 900, 1450),
      token("被讨厌的勇气", 1600, 3000),
      token("你有没有失去过一个重要的人", 3300, 6200),
    ],
  },
]), { episodeTitle: "被讨厌的勇气", audioDuration: 6.2 });
assert.equal(wrongTitleAfterGreeting.ok, false, "extra speech after a known greeting must not be accepted as lead-in");
assert.ok(wrongTitleAfterGreeting.diagnostics.issues.some((issue) => issue.code === "unexpected_leading_speech"));
assert.equal(wrongTitleAfterGreeting.diagnostics.detectedLeadIn, undefined);

const shortOrderedRows = [
  { order: 1, text: "《书名》" },
  { order: 2, text: "甲乙" },
  { order: 3, text: "丙丁" },
];
const shortReorderedText = "书名丙丁甲乙";
const shortReordered = alignScriptToWhisper(shortOrderedRows, asr([
  { text: shortReorderedText, offsets: { from: 0, to: 3000 }, tokens: [token(shortReorderedText, 0, 3000)] },
]), { episodeTitle: "书名", audioDuration: 3 });
assert.equal(shortReordered.ok, false, "short rows spoken out of order must not pass on full character coverage");
assert.ok(shortReordered.diagnostics.issues.some((issue) => issue.code === "script_row_order_mismatch"));

// One of two characters may be omitted by ASR; the remaining exact anchor is
// still a usable timing clue, but the script remains the only subtitle source.
const shortOmissionRows = [
  { order: 1, text: "《书名》" },
  { order: 2, text: "甲乙" },
];
const shortOmission = alignScriptToWhisper(shortOmissionRows, asr([
  { text: "书名甲", offsets: { from: 0, to: 1500 }, tokens: [token("书名甲", 0, 1500)] },
]), { episodeTitle: "书名", audioDuration: 1.5 });
assert.equal(shortOmission.ok, true, "one omitted character in a short row remains alignable when an exact anchor survives");
assert.equal(shortOmission.diagnostics.rows[1].coverage, 0.5);
assert.equal(shortOmission.diagnostics.rows[1].recognizedText, "甲");
assert.equal(shortOmission.diagnostics.requiresAgentReview, true);
assert.equal("text" in shortOmission.captions[1], false);

// A lead-in and body may share one silence segment. Without token offsets, the
// interpolated segment timestamps cannot tell where the lead-in ends.
const oneSegmentNoTokenOffsets = alignScriptToWhisper(overlappingIntroRows, asr([
  {
    text: overlappingIntroText,
    offsets: { from: 0, to: 5000 },
    tokens: [{ text: overlappingIntroText }],
  },
]), { episodeTitle: "朝花夕拾", audioDuration: 5 });
assert.equal(oneSegmentNoTokenOffsets.diagnostics.detectedLeadIn.text, "今天分享的是");
assert.equal(oneSegmentNoTokenOffsets.diagnostics.detectedLeadIn.tokenOffsetsAvailable, false);
assert.equal(oneSegmentNoTokenOffsets.firstScriptTokenOffsetAvailable, false);
assert.equal(deriveSkipLeadingSegments([{ start: 0, end: 5 }], oneSegmentNoTokenOffsets).canDerive, false);

const titlePrefixAsr = asr([
  { text: "被讨厌的勇气", offsets: { from: 0, to: 700 }, tokens: [token("被讨厌的勇气", 0, 700)] },
  ...segmentedAsr.transcription.map((segment) => shiftSegment(segment, 800)),
]);
const titlePrefix = alignScriptToWhisper(rows, titlePrefixAsr, { episodeTitle: "被讨厌的勇气" });
assert.equal(titlePrefix.ok, false);
assert.ok(titlePrefix.diagnostics.issues.some((issue) => issue.code === "leading_title_before_script"));

const suffixAsr = asr([
  ...segmentedAsr.transcription,
  { text: "谢谢", offsets: { from: 4000, to: 4300 }, tokens: [token("谢谢", 4000, 4300)] },
]);
const suffix = alignScriptToWhisper(rows, suffixAsr);
assert.equal(suffix.ok, false);
assert.ok(suffix.diagnostics.issues.some((issue) => issue.code === "unexpected_trailing_speech"));

const missingRow = alignScriptToWhisper(rows, asr([
  { text: "你有没有失去过一个重要的人", offsets: { from: 0, to: 2000 }, tokens: [token("你有没有失去过一个重要的人", 0, 2000)] },
]));
assert.equal(missingRow.ok, false);
assert.equal(missingRow.sequenceMappable, false);
assert.ok(missingRow.diagnostics.issues.some((issue) => issue.code === "script_row_missing_or_mismatched"));

const reordered = alignScriptToWhisper(rows, asr([
  { text: "后来才发现那时就是最好的时候你有没有失去过一个重要的人", offsets: { from: 0, to: 4000 }, tokens: [token("后来才发现那时就是最好的时候你有没有失去过一个重要的人", 0, 4000)] },
]));
assert.equal(reordered.ok, false);

const noTokenOffsetsAsr = asr([
  { text: "你有没有失去过一个重要的人后来才发现那时就是最好的时候", offsets: { from: 0, to: 4000 }, tokens: [
    { text: "你有没有失去过一个重要的人后来才发现那时就是最好的时候" },
  ] },
]);
const noTokenOffsets = alignScriptToWhisper(rows, noTokenOffsetsAsr);
assert.equal(noTokenOffsets.timestampsAvailable, false);
assert.equal(noTokenOffsets.ok, false);
assert.equal(noTokenOffsets.contentValid, true);
assert.ok(noTokenOffsets.diagnostics.issues.some((issue) => issue.code === "token_timestamps_missing"));
assert.equal(noTokenOffsets.firstScriptTokenOffsetAvailable, false);
assert.ok(flattenWhisperCharacters(noTokenOffsetsAsr).characters.every((item) => item.start === null && item.end === null));

const noWhisperText = alignScriptToWhisper(rows, asr([]));
assert.equal(noWhisperText.textAvailable, false);
assert.equal(noWhisperText.diagnostics.contentCheck, "unavailable");

const nearAudioEnd = alignScriptToWhisper(rows, asr([
  { text: "你有没有失去过一个重要的人后来才发现那时就是最好的时候", offsets: { from: 0, to: 4050 }, tokens: [
    token("你有没有失去过一个重要的人后来才发现那时就是最好的时候", 0, 4050),
  ] },
]), { audioDuration: 4 });
assert.equal(nearAudioEnd.ok, true, "a small Whisper end overshoot is tolerated");
assert.ok(nearAudioEnd.captions.every((caption) => caption.start >= 0 && caption.end <= 4));
assert.equal(nearAudioEnd.captions.at(-1).end, 4);

const mildOvershootClamped = alignScriptToWhisper(rows, asr([
  { text: "你有没有失去过一个重要的人后来才发现那时就是最好的时候", offsets: { from: 0, to: 4200 }, tokens: [
    token("你有没有失去过一个重要的人后来才发现那时就是最好的时候", 0, 4200),
  ] },
]), { audioDuration: 4 });
assert.equal(mildOvershootClamped.timestampsAvailable, true, "mild end overshoot (<=1s) is clamped, not fatal");
assert.equal(mildOvershootClamped.ok, false, "clamped overshoot still flags a review note");
assert.ok(mildOvershootClamped.captions.every((caption) => caption.start >= 0 && caption.end <= 4));
assert.equal(mildOvershootClamped.captions.at(-1).end, 4);
assert.ok(mildOvershootClamped.diagnostics.issues.some((issue) => issue.code === "whisper_offsets_clamped"));

const beyondAudioEnd = alignScriptToWhisper(rows, asr([
  { text: "你有没有失去过一个重要的人后来才发现那时就是最好的时候", offsets: { from: 0, to: 8000 }, tokens: [
    token("你有没有失去过一个重要的人后来才发现那时就是最好的时候", 0, 8000),
  ] },
]), { audioDuration: 4 });
assert.equal(beyondAudioEnd.timestampsAvailable, false);
assert.equal(beyondAudioEnd.ok, false);
assert.equal(beyondAudioEnd.contentValid, true, "timestamp range failure does not invent a content mismatch");
assert.ok(beyondAudioEnd.diagnostics.issues.some((issue) => issue.code === "whisper_offsets_out_of_audio_range"));

const nonMonotonic = alignScriptToWhisper(rows, asr([
  {
    text: "你有没有失去过一个重要的人后来才发现那时就是最好的时候",
    offsets: { from: 0, to: 4000 },
    tokens: [
      token("你有没有失去过一个重要的人", 1000, 2500),
      token("后来才发现那时就是最好的时候", 500, 3000),
    ],
  },
]), { audioDuration: 4 });
assert.equal(nonMonotonic.timestampsAvailable, false);
assert.equal(nonMonotonic.ok, false);
assert.ok(nonMonotonic.diagnostics.issues.some((issue) => issue.code === "non_monotonic_token_offsets"));

console.log("Whisper script alignment: ok");
