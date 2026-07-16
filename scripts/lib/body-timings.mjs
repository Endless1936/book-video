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

export function buildCaptionTimings(orders, speechSegments, skipLeading = 1) {
  const startIndex = Math.max(0, Number(skipLeading) || 0);
  const selected = speechSegments.slice(startIndex, startIndex + orders.length);
  if (selected.length !== orders.length) {
    throw new Error(
      `Speech segment count mismatch: found ${speechSegments.length}, need ${orders.length + startIndex} ` +
      `(including skip-leading=${startIndex}). Adjust --skip-leading or the silence settings.`,
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

export function buildEstimatedCaptionTimings(rows, speechSegments, duration, skipLeading = 1) {
  const startIndex = Math.max(0, Number(skipLeading) || 0);
  const selected = speechSegments.slice(startIndex);
  const usableSegments = selected.length
    ? selected
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
