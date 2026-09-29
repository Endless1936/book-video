export function getAtmosphereImageNames(bodyRowCount, maxRowsPerScene = 5) {
  const count = Number(bodyRowCount);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`Invalid body row count: ${bodyRowCount}`);
  }
  if (!Number.isSafeInteger(maxRowsPerScene) || maxRowsPerScene < 1) {
    throw new RangeError(`Invalid scene row limit: ${maxRowsPerScene}`);
  }
  const sceneCount = count === 0 ? 0 : Math.ceil(count / maxRowsPerScene);
  return Array.from({ length: sceneCount }, (_, index) => `atmosphere-${index + 1}.png`);
}

export function segmentCaptionRows(rows, minRows = 3, maxRows = 5) {
  const count = rows.length;
  if (!count) return [];
  if (!Number.isSafeInteger(minRows) || minRows < 1 || !Number.isSafeInteger(maxRows) || maxRows < minRows) {
    throw new RangeError(`Invalid scene row range: ${minRows}-${maxRows}`);
  }

  // For very short scripts, use one scene because a 3-row minimum is impossible.
  const minimum = Math.min(minRows, count);
  const maximum = Math.min(maxRows, count);
  const sceneCount = Math.ceil(count / maximum);
  const totalDuration = Math.max(0.1, rows[count - 1].end - rows[0].start);
  const idealDuration = totalDuration / sceneCount;
  const dp = Array.from({ length: sceneCount + 1 }, () => Array(count + 1).fill(null));
  dp[0][0] = { cost: 0, previous: -1 };

  for (let scenes = 1; scenes <= sceneCount; scenes += 1) {
    const firstEnd = scenes * minimum;
    const lastEnd = Math.min(count, scenes * maximum);
    for (let end = firstEnd; end <= lastEnd; end += 1) {
      for (let size = minimum; size <= maximum; size += 1) {
        const start = end - size;
        if (start < (scenes - 1) * minimum || start > (scenes - 1) * maximum) continue;
        const previous = dp[scenes - 1][start];
        if (!previous) continue;

        const duration = rows[end - 1].end - rows[start].start;
        const pause = start === 0 ? 0 : rows[start].start - rows[start - 1].end;
        const cost = previous.cost + Math.pow(duration - idealDuration, 2) * 0.05 - pause * 1.5;
        if (!dp[scenes][end] || cost < dp[scenes][end].cost) {
          dp[scenes][end] = { cost, previous: start };
        }
      }
    }
  }

  if (!dp[sceneCount][count]) {
    throw new Error(`Could not split ${count} caption rows into ${sceneCount} scenes of ${minimum}-${maximum} rows`);
  }

  const segments = [];
  let end = count;
  for (let scenes = sceneCount; scenes > 0; scenes -= 1) {
    const start = dp[scenes][end].previous;
    const pause = start === 0 ? 0 : rows[start].start - rows[start - 1].end;
    const sceneStart = start > 0 && pause >= 0.15
      ? rows[start - 1].end + pause / 2
      : rows[start].start;
    segments.unshift({ start: sceneStart, end: rows[end - 1].end, rows: rows.slice(start, end) });
    end = start;
  }
  return segments;
}
