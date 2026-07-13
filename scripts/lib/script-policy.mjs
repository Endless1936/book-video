export const MAX_BODY_SCRIPT_LINES = 21;
export const MAX_BODY_SCRIPT_CHARS = 220;

export function validateBodyScript(rows) {
  const lines = rows.length;
  const chars = Array.from(rows.map((row) => String(row.text || "")).join("")).length;
  const errors = [];
  if (lines > MAX_BODY_SCRIPT_LINES) errors.push(`正文最多 ${MAX_BODY_SCRIPT_LINES} 行，当前 ${lines} 行`);
  if (chars > MAX_BODY_SCRIPT_CHARS) errors.push(`正文最多 ${MAX_BODY_SCRIPT_CHARS} 个汉字，当前 ${chars} 个字符`);
  return { lines, chars, errors };
}
