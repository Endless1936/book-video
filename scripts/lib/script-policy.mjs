export const MAX_BODY_SCRIPT_LINES = 40;
export const MAX_BODY_SCRIPT_CHARS = 220;

// Subtitle truth: one clause per line, and a clause carries NO punctuation —
// no commas, no full stops, no quotes, no spaces. Captions must render a
// single line without wrapping; punctuation would force a wrap or split the
// clause. The order-1 book-title row is exempt (it voices the opener, never a
// caption, and legitimately carries 书名号).
const BODY_PUNCTUATION_PATTERN = /[\p{P}\s]/u;

function normalizeTitle(value) {
  return Array.from(String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN"))
    .filter((character) => /[\p{Script=Han}\p{L}\p{N}]/u.test(character))
    .join("");
}

export function validateBodyScript(rows, { episodeTitle = "" } = {}) {
  const lines = rows.length;
  const hasTitleRow = Boolean(String(episodeTitle).trim());
  const bodyRows = hasTitleRow ? rows.slice(1) : rows;
  const bodyLines = bodyRows.length;
  const chars = Array.from(bodyRows.map((row) => String(row.text || "")).join("")).length;
  const errors = [];
  const rawOrders = rows.map((row) => String(row.order ?? "").trim());
  const orders = rawOrders.map(Number);
  const validOrderSequence = rawOrders.every((order) => /^\d+$/u.test(order))
    && orders.every(Number.isSafeInteger)
    && new Set(orders).size === lines
    && [...orders].sort((left, right) => left - right)
      .every((order, index) => order === index + 1);
  if (hasTitleRow && !rows.length) errors.push("script.csv 必须以书名口播行开头");
  if (hasTitleRow && normalizeTitle(rows[0]?.text) !== normalizeTitle(episodeTitle)) {
    errors.push(`script.csv 第一行必须是书名《${episodeTitle}》`);
  }
  if (hasTitleRow && bodyLines === 0) errors.push("书名行之后至少需要一行正文口播");
  if (bodyLines > MAX_BODY_SCRIPT_LINES) errors.push(`正文最多 ${MAX_BODY_SCRIPT_LINES} 行，当前 ${bodyLines} 行`);
  if (hasTitleRow && lines > MAX_BODY_SCRIPT_LINES + 1) {
    errors.push(`口播总行数最多 ${MAX_BODY_SCRIPT_LINES + 1} 行（含书名），当前 ${lines} 行`);
  }
  const bodyRowsWithPunctuation = bodyRows.filter((row) => BODY_PUNCTUATION_PATTERN.test(String(row.text || "")));
  if (bodyRowsWithPunctuation.length) {
    errors.push(`正文必须一分句一行且不含任何标点（逗号、句号等）与空白，当前违规行：${bodyRowsWithPunctuation.map((row) => row.order).join("、")}`);
  }
  if (chars > MAX_BODY_SCRIPT_CHARS) errors.push(`正文最多 ${MAX_BODY_SCRIPT_CHARS} 个汉字，当前 ${chars} 个字符`);
  if (!validOrderSequence) errors.push(`正文 order 必须唯一且连续为 1..${lines}`);
  return { lines, chars, errors };
}
