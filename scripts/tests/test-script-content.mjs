import assert from "node:assert/strict";
import { checkScriptContent } from "../lib/body-timings.mjs";

function asr(text, splitInto = 1) {
  const segmentTexts = splitInto > 1 ? text.split(/(?<=\uFF0C|\u3002|\n)/u) : [text];
  const transcription = segmentTexts.filter(Boolean).map((segmentText) => ({
    text: segmentText,
    tokens: Array.from(segmentText).map((character) => ({ text: character })),
  }));
  return { transcription };
}

const rows = [
  { order: 1, text: "《被讨厌的勇气》" },
  { order: 2, text: "很多时候让你痛苦的" },
  { order: 3, text: "不是别人的讨厌" },
  { order: 4, text: "而是你太害怕被讨厌" },
];

const fullText = rows.map((row) => row.text).join("");

function blockingCodes(result) {
  return (result.diagnostics.blockingIssues || []).map((issue) => issue.code);
}

// 1. Perfect recognition is valid.
{
  const result = checkScriptContent(rows, asr(fullText), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.textAvailable, true);
  assert.equal(result.contentValid, true);
  assert.equal(result.ok, true);
  assert.ok(result.diagnostics.rows.every((row) => row.exact));
}

// 2. Traditional-vs-simplified variance must not block.
{
  const traditional = "《被討厭的勇氣》很多時候讓你痛苦的不是別人的討厭而是你太害怕被討厭";
  const result = checkScriptContent(rows, asr(traditional), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, true, `blocking: ${blockingCodes(result).join(",")}`);
}

// 3. A single-character ASR substitution is reviewable, not blocking.
{
  const variant = fullText.replace("痛苦的", "痛哭的");
  const result = checkScriptContent(rows, asr(variant), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, true, `blocking: ${blockingCodes(result).join(",")}`);
  assert.equal(result.diagnostics.requiresAgentReview, true);
}

// 4. A duplicated/garbled internal segment blocks.
{
  const duplicated = fullText.replace("很多时候让你痛苦的", "很多时候让你痛苦的很多时候让你痛苦的");
  const result = checkScriptContent(rows, asr(duplicated), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, false);
  assert.ok(blockingCodes(result).includes("unexpected_internal_speech"));
}

// 5. A missing row blocks.
{
  const missing = rows.map((row) => row.text).filter((text) => text !== "不是别人的讨厌").join("");
  const result = checkScriptContent(rows, asr(missing), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, false);
  assert.ok(blockingCodes(result).includes("script_row_missing_or_mismatched"));
}

// 6. Reordered rows block (mapped as internal extra speech or order mismatch).
{
  const reordered = [rows[0].text, rows[3].text, rows[1].text, rows[2].text].join("");
  const result = checkScriptContent(rows, asr(reordered), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, false);
  assert.ok(
    blockingCodes(result).includes("unexpected_internal_speech")
    || blockingCodes(result).includes("script_row_order_mismatch"),
  );
}

// 7. Extra trailing speech blocks.
{
  const withTrailing = `${fullText}谢谢大家`;
  const result = checkScriptContent(rows, asr(withTrailing), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, false);
  assert.ok(blockingCodes(result).includes("unexpected_trailing_speech"));
}

// 8. A known spoken opener is tolerated (detected lead-in, not blocking).
{
  const withGreeting = `今天分享的是${fullText}`;
  const result = checkScriptContent(rows, asr(withGreeting), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, true, `blocking: ${blockingCodes(result).join(",")}`);
  assert.equal(result.diagnostics.detectedLeadIn.text, "今天分享的是");
}

// 9. Unknown leading speech blocks.
{
  const withJunk = `乱七八糟${fullText}`;
  const result = checkScriptContent(rows, asr(withJunk), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, false);
  assert.ok(blockingCodes(result).includes("unexpected_leading_speech"));
}

// 10. Empty transcription is unavailable, not blocked.
{
  const result = checkScriptContent(rows, asr(""), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.textAvailable, false);
  assert.equal(result.contentValid, false);
  assert.equal(result.diagnostics.contentCheck, "unavailable");
}

// 11. No readable rows is unavailable.
{
  const result = checkScriptContent([], asr("随便说说"), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, false);
  assert.equal(result.diagnostics.contentCheck, "unavailable");
}

// 12. Title-only recognition of a garbled body still maps row 1.
{
  const titleOnly = "《被讨厌的勇气》";
  const result = checkScriptContent(rows, asr(titleOnly), { episodeTitle: "被讨厌的勇气" });
  assert.equal(result.contentValid, false);
  assert.ok(blockingCodes(result).includes("script_row_missing_or_mismatched"));
}

console.log("script content check (Whisper text only): ok");
