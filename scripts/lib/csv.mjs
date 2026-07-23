import fs from "node:fs";

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      record.push(current);
      current = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(current);
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      current = "";
    } else {
      current += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  record.push(current);
  if (record.some((value) => value !== "")) records.push(record);
  return records;
}

export function parseCsvLine(line) {
  return parseCsvRecords(line)[0] || [""];
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function csvRow(values) {
  return values.map(csvEscape).join(",");
}

export function readCsv(filePath) {
  const records = parseCsvRecords(fs.readFileSync(filePath, "utf8"));
  const headers = records.shift() || [];
  const rows = records.map((values) => (
    Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]))
  ));
  return { headers, rows };
}
