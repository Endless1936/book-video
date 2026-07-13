import fs from "node:fs";
import path from "node:path";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function unwrapValue(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function readEnvValue(name, filePath = path.join(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return "";
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=\\s*(.*?)\\s*$`, "u");
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(assignment);
    if (match) return unwrapValue(match[1]);
  }
  return "";
}
