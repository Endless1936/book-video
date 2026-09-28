export const MAX_BODY_SCRIPT_LINES = 21;
export const MAX_BODY_SCRIPT_CHARS = 220;

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
  if (chars > MAX_BODY_SCRIPT_CHARS) errors.push(`正文最多 ${MAX_BODY_SCRIPT_CHARS} 个汉字，当前 ${chars} 个字符`);
  if (!validOrderSequence) errors.push(`正文 order 必须唯一且连续为 1..${lines}`);
  return { lines, chars, errors };
}
