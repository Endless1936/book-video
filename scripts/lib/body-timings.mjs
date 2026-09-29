function roundSeconds(value) {
  return Number(Number(value).toFixed(2));
}

export function parseSilenceEvents(output) {
  const events = [];
  const pattern = /silence_(start|end):\s*([0-9.]+)/gu;
  for (const match of String(output).matchAll(pattern)) {
    events.push({ type: match[1], time: Number(match[2]) });
  }
  return events;
}

const INTRO_PREFIXES = [
  "大家好",
  "今天分享的是",
  "今天想分享",
  "今天给大家分享",
  "今天和大家聊",
  "今天我们来聊",
  "今天来聊聊",
  "今天想聊聊",
  "这一期来聊",
  "这期来聊",
];

// Whisper (especially on Mandarin audio) often emits traditional characters even
// when the script is simplified. Normalize the common traditional forms that
// appear in this voiceover before comparing, so 繁/简 does not count as a mismatch.
const TRAD_TO_SIMP = {
  "討": "讨", "厭": "厌", "讓": "让", "說": "说", "話": "话", "課": "课", "題": "题",
  "麼": "么", "換": "换", "歡": "欢", "夠": "够", "眾": "众", "遠": "远", "這": "这",
  "終": "终", "於": "于", "氣": "气", "別": "别", "錯": "错", "滿": "满", "對": "对",
  "從": "从", "個": "个", "對": "对", "後": "后", "來": "来", "時": "时", "為": "为",
  "麼": "么", "還": "还", "過": "过", "請": "请", "謝": "谢", "見": "见", "認": "认",
  "識": "识", "論": "论", "壞": "坏", "處": "处", "點": "点", "邊": "边", "題": "题",
};
function toSimplified(text) {
  return Array.from(text).map((ch) => TRAD_TO_SIMP[ch] || ch).join("");
}

export function normalizeSpeechText(value) {
  return toSimplified(Array.from(String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN"))
    .filter((character) => /[\p{Script=Han}\p{L}\p{N}]/u.test(character))
    .join(""));
}

function editDistance(leftText, rightText) {
  const left = Array.from(leftText);
  const right = Array.from(rightText);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function readOffsets(value) {
  const from = Number(value?.from);
  const to = Number(value?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) return null;
  // whisper.cpp -ojf offsets are milliseconds.
  return { start: from / 1000, end: to / 1000 };
}

function appendTimedText(target, value, offsets, metadata = {}) {
  const characters = Array.from(normalizeSpeechText(value));
  if (!characters.length) return;
  const interval = offsets || { start: null, end: null };
  characters.forEach((character, index) => {
    const start = Number.isFinite(interval.start)
      ? interval.start + ((interval.end - interval.start) * index) / characters.length
      : null;
    const end = Number.isFinite(interval.end)
      ? interval.start + ((interval.end - interval.start) * (index + 1)) / characters.length
      : null;
    target.push({ character, start, end, ...metadata });
  });
}

export function flattenWhisperCharacters(asr) {
  const characters = [];
  let hasTokenTimestamps = true;
  let usedSegmentFallback = false;
  const segments = Array.isArray(asr?.transcription) ? asr.transcription : [];

  segments.forEach((segment, segmentIndex) => {
    const tokens = Array.isArray(segment?.tokens) ? segment.tokens : [];
    if (tokens.length) {
      for (const token of tokens) {
        if (typeof token?.text === "string" && token.text.startsWith("[_")) continue; // Whisper control/timestamp tokens e.g. [_BEG_], [_TT_94]
        const normalized = normalizeSpeechText(token?.text);
        if (!normalized) continue; // Ignore punctuation and Whisper control tokens.
        const offsets = readOffsets(token?.offsets);
        if (!offsets) {
          hasTokenTimestamps = false;
          usedSegmentFallback = true;
          // Keep recognized text for sequence matching, but never invent token times.
          appendTimedText(characters, token.text, null, { segmentIndex, timestampSource: "missing" });
          continue;
        }
        appendTimedText(characters, token.text, offsets, {
          segmentIndex,
          timestampSource: "token",
        });
      }
    } else {
      const normalized = normalizeSpeechText(segment?.text);
      if (!normalized) return;
      hasTokenTimestamps = false;
      usedSegmentFallback = true;
      appendTimedText(characters, segment.text, readOffsets(segment?.offsets), {
        segmentIndex,
        timestampSource: readOffsets(segment?.offsets) ? "segment" : "missing",
      });
    }
  });

  // Keep real token timestamps distinct from missing values. Caption timing can
  // fall back downstream; generated greeting splits need their own real anchors.
  const allFinite = characters.length > 0 && characters.every(c => Number.isFinite(c.start) && Number.isFinite(c.end));
  return { characters, hasTokenTimestamps, usedSegmentFallback, timelineEstimated: allFinite && !hasTokenTimestamps };
}

function alignCharacterSequences(expected, recognized) {
  const rows = expected.length + 1;
  const columns = recognized.length + 1;
  const costs = Array.from({ length: rows }, () => new Uint32Array(columns));
  const directions = Array.from({ length: rows }, () => new Uint8Array(columns));
  for (let i = 1; i < rows; i += 1) {
    costs[i][0] = i;
    directions[i][0] = 1; // Missing expected character.
  }
  for (let j = 1; j < columns; j += 1) {
    costs[0][j] = j;
    directions[0][j] = 2; // Extra recognized character.
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const diagonalCost = costs[i - 1][j - 1] + (expected[i - 1].character === recognized[j - 1].character ? 0 : 1);
      const deleteCost = costs[i - 1][j] + 1;
      const insertCost = costs[i][j - 1] + 1;
      // Stable tie breaking prefers preserving character-to-time matches.
      if (diagonalCost <= deleteCost && diagonalCost <= insertCost) {
        costs[i][j] = diagonalCost;
        directions[i][j] = 0;
      } else if (deleteCost <= insertCost) {
        costs[i][j] = deleteCost;
        directions[i][j] = 1;
      } else {
        costs[i][j] = insertCost;
        directions[i][j] = 2;
      }
    }
  }

  const expectedToRecognized = new Map();
  const recognizedUsed = new Set();
  let expectedIndex = expected.length;
  let recognizedIndex = recognized.length;
  let substitutions = 0;
  let missingCharacters = 0;
  let extraCharacters = 0;
  while (expectedIndex > 0 || recognizedIndex > 0) {
    const direction = directions[expectedIndex][recognizedIndex];
    if (expectedIndex > 0 && recognizedIndex > 0 && direction === 0) {
      const expectedCharacter = expected[expectedIndex - 1].character;
      const recognizedCharacter = recognized[recognizedIndex - 1].character;
      expectedToRecognized.set(expectedIndex - 1, recognizedIndex - 1);
      recognizedUsed.add(recognizedIndex - 1);
      if (expectedCharacter !== recognizedCharacter) substitutions += 1;
      expectedIndex -= 1;
      recognizedIndex -= 1;
    } else if (expectedIndex > 0 && (recognizedIndex === 0 || direction === 1)) {
      missingCharacters += 1;
      expectedIndex -= 1;
    } else {
      extraCharacters += 1;
      recognizedIndex -= 1;
    }
  }

  const mappedIndexes = [...expectedToRecognized.values()];
  const firstMapped = mappedIndexes.length ? Math.min(...mappedIndexes) : recognized.length;
  const lastMapped = mappedIndexes.length ? Math.max(...mappedIndexes) : -1;
  const prefixIndexes = [];
  const suffixIndexes = [];
  const internalExtraIndexes = [];
  for (let index = 0; index < recognized.length; index += 1) {
    if (recognizedUsed.has(index)) continue;
    if (index < firstMapped) prefixIndexes.push(index);
    else if (index > lastMapped) suffixIndexes.push(index);
    else internalExtraIndexes.push(index);
  }

  return {
    cost: costs[expected.length][recognized.length],
    expectedToRecognized,
    substitutions,
    missingCharacters,
    extraCharacters,
    prefixIndexes,
    suffixIndexes,
    internalExtraIndexes,
  };
}

function textAtIndexes(characters, indexes) {
  return indexes.map((index) => characters[index].character).join("");
}

function likelyIntroPrefix(text) {
  const normalized = normalizeSpeechText(text);
  return INTRO_PREFIXES.some((prefix) => {
    const expected = normalizeSpeechText(prefix);
    // Treat only the complete unmatched prefix as an intro. `startsWith`
    // would silently absorb extra speech (for example, a wrong book title)
    // into an otherwise familiar greeting.
    return editDistance(normalized, expected) <= 1;
  });
}

export function alignScriptToWhisper(rows, asr, { episodeTitle = "", audioDuration = null } = {}) {
  const expected = rows.flatMap((row, rowIndex) => Array.from(normalizeSpeechText(row.text)).map((character) => ({
    character,
    rowIndex,
  })));
  const flattened = flattenWhisperCharacters(asr);
  const recognized = flattened.characters;
  const result = {
    ok: false,
    contentValid: false,
    sequenceMappable: false,
    textAvailable: recognized.length > 0,
    // timestampsAvailable = we can produce a numeric timeline for captions.
    // timelineEstimated = some numbers came from our fallback, not real whisper
    // token offsets. The greeting split must require real anchors regardless.
    timestampsAvailable: recognized.every((item) => Number.isFinite(item.start) && Number.isFinite(item.end)),
    timelineEstimated: flattened.timelineEstimated === true,
    usedSegmentFallback: flattened.usedSegmentFallback,
    captions: [],
    firstScriptTokenTime: null,
    firstScriptTokenOffsetAvailable: false,
    diagnostics: {
      scriptRows: rows.length,
      scriptCharacters: expected.length,
      recognizedCharacters: recognized.length,
      recognizedText: recognized.map((item) => item.character).join(""),
      issues: [],
      rows: [],
    },
  };

  const finiteAudioDuration = Number.isFinite(Number(audioDuration)) && Number(audioDuration) > 0
    ? Number(audioDuration)
    : null;
  if (finiteAudioDuration !== null) {
    result.diagnostics.audioDurationSeconds = roundSeconds(finiteAudioDuration);
    result.diagnostics.audioBoundaryToleranceSeconds = 0.1;
  }

  const tokensMonotonic = recognized.every((item, index) => index === 0
    || item.start >= recognized[index - 1].start - 0.03);
  if (!tokensMonotonic) {
    result.timestampsAvailable = false;
    result.diagnostics.issues.push({
      code: "non_monotonic_token_offsets",
      message: "Whisper token offsets go backwards in audio time; timestamp alignment cannot be trusted.",
    });
  }

  const outOfRangeCharacters = finiteAudioDuration === null ? [] : recognized.filter((item) =>
    !Number.isFinite(item.start)
    || !Number.isFinite(item.end)
    || item.start < 0
    || item.start >= finiteAudioDuration
    || item.end <= 0
    || item.end > finiteAudioDuration + 0.1);
  if (outOfRangeCharacters.length) {
    result.timestampsAvailable = false;
    result.diagnostics.issues.push({
      code: "whisper_offsets_out_of_audio_range",
      message: `${outOfRangeCharacters.length} Whisper character timestamp(s) fall outside the ${finiteAudioDuration.toFixed(2)}s audio duration (0.1s end tolerance).`,
      count: outOfRangeCharacters.length,
      first: {
        text: outOfRangeCharacters.slice(0, 12).map((item) => item.character).join(""),
        start: outOfRangeCharacters[0].start,
        end: outOfRangeCharacters[0].end,
      },
    });
  }

  if (!expected.length) result.diagnostics.issues.push({ code: "empty_script", message: "No readable script characters were provided." });
  if (!recognized.length) result.diagnostics.issues.push({ code: "empty_whisper_text", message: "Whisper returned no readable speech tokens." });
  if (!flattened.hasTokenTimestamps) {
    result.diagnostics.issues.push({
      code: "token_timestamps_missing",
      message: "Whisper token offsets are missing; exact timestamp alignment is unavailable.",
    });
  }
  if (recognized.some((item) => !Number.isFinite(item.start) || !Number.isFinite(item.end))) {
    result.diagnostics.issues.push({
      code: "invalid_token_offsets",
      message: "One or more recognized tokens have no valid offsets.from/to timestamps.",
    });
  }
  if (!expected.length || !recognized.length) {
    result.diagnostics.contentCheck = "unavailable";
    result.diagnostics.contentCheckReason = !recognized.length ? "Whisper returned no readable text." : "The script has no readable text.";
    return result;
  }

  let aligned = alignCharacterSequences(expected, recognized);
  let alignmentOffset = 0;
  let alignmentIntroDistance = Number.POSITIVE_INFINITY;
  let alignmentIntroLengthDelta = Number.POSITIVE_INFINITY;
  const title = normalizeSpeechText(episodeTitle);
  const recognizedText = recognized.map((item) => item.character).join("");
  // If a known spoken opener also appears at the start of the script, prefer
  // the later body occurrence only when it produces a strictly better match.
  for (const intro of INTRO_PREFIXES.map(normalizeSpeechText).sort((left, right) => right.length - left.length)) {
    if (!intro) continue;
    if (title.length >= 2 && intro.includes(title)) continue;
    const expectedIntroLength = Array.from(intro).length;
    for (let candidateOffset = Math.max(1, expectedIntroLength - 2); candidateOffset <= expectedIntroLength + 2; candidateOffset += 1) {
      if (candidateOffset >= recognized.length) continue;
      const prefixDistance = editDistance(normalizeSpeechText(recognizedText.slice(0, candidateOffset)), intro);
      if (prefixDistance > 1) continue;
      const candidate = alignCharacterSequences(expected, recognized.slice(candidateOffset));
      const introLengthDelta = Math.abs(candidateOffset - expectedIntroLength);
      if (
        candidate.cost < aligned.cost
        || (
          candidate.cost === aligned.cost
          && (
            prefixDistance < alignmentIntroDistance
            || (prefixDistance === alignmentIntroDistance && introLengthDelta < alignmentIntroLengthDelta)
          )
        )
      ) {
        aligned = candidate;
        alignmentOffset = candidateOffset;
        alignmentIntroDistance = prefixDistance;
        alignmentIntroLengthDelta = introLengthDelta;
      }
    }
  }
  const localPrefixIndexes = aligned.prefixIndexes.map((index) => index + alignmentOffset);
  const suffixIndexes = aligned.suffixIndexes.map((index) => index + alignmentOffset);
  const prefixIndexes = [...Array.from({ length: alignmentOffset }, (_, index) => index), ...localPrefixIndexes];
  const prefixText = textAtIndexes(recognized, prefixIndexes);
  const suffixText = textAtIndexes(recognized, suffixIndexes);
  const internalExtraText = textAtIndexes(recognized, aligned.internalExtraIndexes.map((index) => index + alignmentOffset));
  const firstExpectedTitleIndex = expected.findIndex((item) => item.rowIndex === 0);
  const firstMappedTitleCharacter = [...aligned.expectedToRecognized.entries()]
    .filter(([expectedIndex]) => expected[expectedIndex]?.rowIndex === 0)
    .sort(([left], [right]) => left - right)[0];
  const firstScriptIndex = aligned.expectedToRecognized.get(firstExpectedTitleIndex);
  const firstRecognizedIndex = Number.isInteger(firstScriptIndex) ? firstScriptIndex + alignmentOffset : null;

  // A generated split needs the first expected title character itself. If Whisper
  // drops it, using the next character could cut off the spoken title opening.
  const firstScript = firstRecognizedIndex === null ? null : recognized[firstRecognizedIndex];
  if (firstScript?.timestampSource === "token" && Number.isFinite(firstScript.start)) {
    result.firstScriptTokenTime = firstScript.start;
    result.firstScriptTokenOffsetAvailable = true;
    result.diagnostics.firstMappedTitleCharacter = firstMappedTitleCharacter?.[0] ?? 0;
  } else if (firstExpectedTitleIndex >= 0 && !Number.isInteger(firstScriptIndex)) {
    result.diagnostics.titleStartAnchorUnavailable = true;
  }

  if (prefixText) {
    const prefixChars = prefixIndexes.map((index) => recognized[index]);
    const timedPrefixChars = prefixChars.filter((item) => item.timestampSource === "token"
      && Number.isFinite(item.start) && Number.isFinite(item.end));
    const prefixDuration = timedPrefixChars.length
      ? Math.max(...timedPrefixChars.map((item) => item.end)) - Math.min(...timedPrefixChars.map((item) => item.start))
      : Number.POSITIVE_INFINITY;
    const containsTitle = title.length >= 2 && prefixText.includes(title);
    if (containsTitle) {
      result.diagnostics.issues.push({
        code: "leading_title_before_script",
        message: `Whisper detected the book title before the approved script: “${prefixText}”.`,
        text: prefixText,
      });
    } else if (!likelyIntroPrefix(prefixText) || prefixChars.length > 36
      || (Number.isFinite(prefixDuration) && prefixDuration > 4)) {
      result.diagnostics.issues.push({
        code: "unexpected_leading_speech",
        message: `Unmatched speech precedes the script: “${prefixText}”.`,
        text: prefixText,
      });
    } else {
      result.diagnostics.detectedLeadIn = {
        text: prefixText,
        tokenOffsetsAvailable: prefixChars.at(-1)?.timestampSource === "token"
          && Number.isFinite(prefixChars.at(-1)?.end),
        start: prefixChars.find((item) => item.timestampSource === "token" && Number.isFinite(item.start))?.start ?? null,
        end: prefixChars.at(-1)?.timestampSource === "token" && Number.isFinite(prefixChars.at(-1)?.end)
          ? prefixChars.at(-1).end
          : null,
      };
    }
  }
  if (suffixText) {
    result.diagnostics.issues.push({
      code: "unexpected_trailing_speech",
      message: `Unmatched speech follows the approved script: “${suffixText}”.`,
      text: suffixText,
    });
  }

  const mappedByRow = rows.map(() => []);
  const normalizedRows = rows.map((row) => normalizeSpeechText(row.text));
  const hasTitleRow = Boolean(title && normalizedRows[0] === title);
  for (const [expectedIndex, recognizedIndex] of aligned.expectedToRecognized) {
    mappedByRow[expected[expectedIndex].rowIndex].push({
      expectedCharacter: expected[expectedIndex].character,
      recognized: recognized[recognizedIndex + alignmentOffset],
    });
  }
  let totalMatched = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const expectedCount = expected.filter((item) => item.rowIndex === rowIndex).length;
    const mappings = mappedByRow[rowIndex].sort((left, right) => left.recognized.start - right.recognized.start);
    const recognizedIndexes = [...aligned.expectedToRecognized]
      .filter(([expectedIndex]) => expected[expectedIndex].rowIndex === rowIndex)
      .map(([, recognizedIndex]) => recognizedIndex + alignmentOffset);
    const recognizedStartIndex = recognizedIndexes.length ? Math.min(...recognizedIndexes) : null;
    const recognizedEndIndex = recognizedIndexes.length ? Math.max(...recognizedIndexes) : null;
    const rowRecognizedText = recognizedStartIndex === null
      ? ""
      : recognized.slice(recognizedStartIndex, recognizedEndIndex + 1).map((item) => item.character).join("");
    const matchedCount = mappings.length;
    const rowCoverage = expectedCount ? matchedCount / expectedCount : 0;
    const rowMismatches = mappedByRow[rowIndex].filter((item) => item.expectedCharacter !== item.recognized.character).length;
    const expectedText = normalizedRows[rowIndex];
    const rowEditDistance = editDistance(expectedText, rowRecognizedText);
    const isTitleRow = rowIndex === 0 && hasTitleRow;
    const rowEditRate = isTitleRow ? 0.1 : 0.2;
    const maxRowEditDistance = Math.max(1, Math.floor(expectedCount * rowEditRate));
    const exactAnchors = mappedByRow[rowIndex]
      .filter((item) => item.expectedCharacter === item.recognized.character).length;
    totalMatched += matchedCount;
    result.diagnostics.rows.push({
      order: Number(rows[rowIndex].order),
      role: isTitleRow ? "title" : "body",
      expectedCharacters: expectedCount,
      mappedCharacters: matchedCount,
      coverage: Number(rowCoverage.toFixed(3)),
      recognizedText: rowRecognizedText,
      substitutions: rowMismatches,
      editDistance: rowEditDistance,
      maxToleratedEditDistance: maxRowEditDistance,
      exactAnchors,
      exact: rowCoverage === 1 && rowMismatches === 0 && rowRecognizedText === expectedText,
      timestampStart: mappings[0]?.recognized.start ?? null,
      timestampEnd: mappings.at(-1)?.recognized.end ?? null,
    });
    const anchoredShortRowWithOneOmission = expectedCount <= 4
      && matchedCount > 0
      && exactAnchors > 0
      && rowEditDistance === 1
      && rowRecognizedText.length === expectedCount - 1;
    if (
      matchedCount < Math.min(1, expectedCount)
      || (rowCoverage < 0.6 && !anchoredShortRowWithOneOmission)
    ) {
      result.diagnostics.issues.push({
        code: "script_row_missing_or_mismatched",
        order: Number(rows[rowIndex].order),
        message: `Script row ${rows[rowIndex].order} has only ${matchedCount}/${expectedCount} characters aligned to speech.`,
      });
    }

    if (matchedCount > 0 && (exactAnchors === 0 || rowEditDistance > maxRowEditDistance)) {
      result.diagnostics.issues.push({
        code: isTitleRow ? "script_title_mismatch" : "script_row_text_mismatch",
        order: Number(rows[rowIndex].order),
        message: `Whisper text for script row ${rows[rowIndex].order} is not close enough to its approved text: “${rowRecognizedText}” (edit distance ${rowEditDistance}/${expectedCount}; ${exactAnchors} exact anchors).`,
        expectedText,
        recognizedText: rowRecognizedText,
        editDistance: rowEditDistance,
        exactAnchors,
      });
    }

    if (matchedCount > 0 && rowEditDistance > 0) {
      const reorderedMatch = normalizedRows
        .map((candidateText, candidateIndex) => ({
          candidateText,
          candidateIndex,
          distance: candidateIndex === rowIndex ? Number.POSITIVE_INFINITY : editDistance(candidateText, rowRecognizedText),
        }))
        .filter((candidate) => candidate.candidateText)
        .sort((left, right) => left.distance - right.distance)[0];
      const clearlyMatchesOtherRow = reorderedMatch && (
        reorderedMatch.distance === 0
        || (
          reorderedMatch.distance <= Math.max(1, Math.floor(reorderedMatch.candidateText.length * 0.2))
          && rowEditDistance - reorderedMatch.distance >= Math.max(2, Math.floor(expectedCount * 0.1))
        )
      );
      if (clearlyMatchesOtherRow) {
        result.diagnostics.issues.push({
          code: "script_row_order_mismatch",
          order: Number(rows[rowIndex].order),
          matchedOrder: Number(rows[reorderedMatch.candidateIndex].order),
          message: `Whisper text aligned to script row ${rows[rowIndex].order} matches row ${rows[reorderedMatch.candidateIndex].order} more closely; spoken row order may differ from the approved script.`,
          recognizedText: rowRecognizedText,
        });
      }
    }
  }

  const reviewEditDistance = Math.max(2, Math.floor(expected.length * 0.04));
  const maxEditDistance = Math.max(6, Math.floor(expected.length * 0.18));
  result.diagnostics.editDistance = aligned.cost + alignmentOffset;
  result.diagnostics.reviewEditDistance = reviewEditDistance;
  result.diagnostics.maxToleratedEditDistance = maxEditDistance;
  result.diagnostics.substitutions = aligned.substitutions;
  result.diagnostics.missingCharacters = aligned.missingCharacters;
  result.diagnostics.extraCharacters = aligned.extraCharacters + alignmentOffset;
  const effectiveEditDistance = Math.max(0, aligned.cost - aligned.prefixIndexes.length - aligned.suffixIndexes.length);
  result.diagnostics.effectiveEditDistance = effectiveEditDistance;
  result.diagnostics.contentCheck = "matched";
  result.diagnostics.requiresAgentReview = effectiveEditDistance > 0
    || effectiveEditDistance > reviewEditDistance
    || result.diagnostics.rows.some((row) => !row.exact);
  if (result.diagnostics.requiresAgentReview) {
    result.diagnostics.contentCheck = "matched_with_asr_variance";
  }
  if (effectiveEditDistance > maxEditDistance) {
    result.diagnostics.issues.push({
      code: "script_text_mismatch",
      message: `Whisper/script edit distance ${effectiveEditDistance} exceeds the content alignment limit ${maxEditDistance}.`,
    });
  }
  if (internalExtraText) {
    result.diagnostics.internalExtraText = internalExtraText;
    if (internalExtraText.length > 2) {
      result.diagnostics.issues.push({
        code: "unexpected_internal_speech",
        message: `Whisper detected extra speech inside the script sequence: “${internalExtraText}”.`,
        text: internalExtraText,
      });
    }
  }

  const timestampIssueCodes = new Set([
    "token_timestamps_missing",
    "invalid_token_offsets",
    "non_monotonic_token_offsets",
    "whisper_offsets_out_of_audio_range",
  ]);
  const reviewableTextIssueCodes = new Set([
    "script_title_mismatch",
    "script_row_text_mismatch",
    "script_text_mismatch",
  ]);
  result.contentValid = result.diagnostics.issues.every((issue) => timestampIssueCodes.has(issue.code));
  result.sequenceMappable = result.diagnostics.issues.every((issue) =>
    timestampIssueCodes.has(issue.code) || reviewableTextIssueCodes.has(issue.code));
  result.ok = result.diagnostics.issues.length === 0;
  if (result.timestampsAvailable && totalMatched > 0) {
    result.captions = rows.map((row, rowIndex) => {
      const mappings = mappedByRow[rowIndex].sort((left, right) => left.recognized.start - right.recognized.start);
      const rawStart = mappings[0]?.recognized.start;
      const rawEnd = mappings.at(-1)?.recognized.end;
      const start = finiteAudioDuration === null
        ? rawStart
        : Math.min(finiteAudioDuration, Math.max(0, rawStart));
      const end = finiteAudioDuration === null
        ? Math.max(start + 0.08, rawEnd)
        : Math.min(finiteAudioDuration, Math.max(start + 0.08, rawEnd));
      return {
        order: Number(row.order),
        start: roundSeconds(start),
        end: roundSeconds(end),
      };
    });
  }
  return result;
}

export function deriveSkipLeadingSegments(speechSegments, alignment) {
  const leadIn = alignment?.diagnostics?.detectedLeadIn;
  if (!leadIn) return { canDerive: true, skipLeading: 0 };
  const hasReliableTokenOffsets = alignment.firstScriptTokenOffsetAvailable
    && leadIn.tokenOffsetsAvailable;
  if (!hasReliableTokenOffsets || !Number.isFinite(alignment.firstScriptTokenTime)) {
    return { canDerive: false, skipLeading: 0 };
  }
  return {
    canDerive: true,
    skipLeading: speechSegments.filter((segment) => segment.end <= alignment.firstScriptTokenTime + 0.02).length,
  };
}

export function buildSpeechSegments(duration, events) {
  const segments = [];
  let speechStart = 0;
  let inSilence = false;

  for (const event of events) {
    if (!Number.isFinite(event.time)) continue;
    if (event.type === "start" && !inSilence) {
      if (event.time > speechStart) segments.push({ start: speechStart, end: event.time });
      inSilence = true;
    } else if (event.type === "end" && inSilence) {
      speechStart = event.time;
      inSilence = false;
    }
  }

  if (!inSilence && duration > speechStart) segments.push({ start: speechStart, end: duration });
  return segments.filter((segment) => segment.end - segment.start >= 0.08);
}

export function coalesceSpeechSegments(segments, targetCount) {
  const result = segments.map((segment) => ({ ...segment }));
  while (result.length > targetCount) {
    let mergeIndex = 0;
    let shortestGap = Number.POSITIVE_INFINITY;
    for (let index = 0; index < result.length - 1; index += 1) {
      const gap = result[index + 1].start - result[index].end;
      if (gap < shortestGap) {
        shortestGap = gap;
        mergeIndex = index;
      }
    }
    result.splice(mergeIndex, 2, {
      start: result[mergeIndex].start,
      end: result[mergeIndex + 1].end,
    });
  }
  return result;
}

export function buildCaptionTimings(orders, speechSegments) {
  const selected = speechSegments.slice(0, orders.length);
  if (selected.length !== orders.length) {
    throw new Error(
      `Speech segment count mismatch: found ${speechSegments.length}, need ${orders.length} after detected lead-in filtering.`,
    );
  }

  return selected.map((segment, index) => ({
    order: Number(orders[index]),
    start: roundSeconds(segment.start),
    end: roundSeconds(segment.end),
  }));
}

function timeAtSpeechOffset(segments, offset) {
  let remaining = Math.max(0, offset);
  for (const segment of segments) {
    const length = segment.end - segment.start;
    if (remaining <= length) return segment.start + remaining;
    remaining -= length;
  }
  return segments.at(-1)?.end ?? 0;
}

export function buildEstimatedCaptionTimings(rows, speechSegments, duration) {
  const usableSegments = speechSegments.length
    ? speechSegments
    : [{ start: 0, end: Math.max(0.3, Number(duration) || 0.3) }];
  const totalSpeech = usableSegments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
  const weights = rows.map((row) => {
    const durationHint = Number(row.duration_hint);
    if (Number.isFinite(durationHint) && durationHint > 0) return durationHint;
    return Math.max(1, String(row.text).replace(/\s+/gu, "").length);
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let consumedWeight = 0;

  return rows.map((row, index) => {
    const startOffset = totalSpeech * (consumedWeight / totalWeight);
    consumedWeight += weights[index];
    const endOffset = totalSpeech * (consumedWeight / totalWeight);
    const start = timeAtSpeechOffset(usableSegments, startOffset);
    const end = Math.max(start + 0.3, timeAtSpeechOffset(usableSegments, endOffset));
    return {
      order: Number(row.order),
      start: roundSeconds(start),
      end: roundSeconds(end),
    };
  });
}
