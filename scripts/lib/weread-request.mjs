import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
export const WEREAD_SKILL_VERSION = "1.0.4";

function envFileValue(name) {
  const filePath = path.join(ROOT, ".env");
  if (!fs.existsSync(filePath)) return "";
  const line = fs.readFileSync(filePath, "utf8").split(/\r?\n/u).find((item) => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^['"]|['"]$/gu, "") : "";
}

export function getWeReadApiKey() {
  return process.env.WEREAD_API_KEY || envFileValue("WEREAD_API_KEY");
}

function publicError(message) {
  return String(message).replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/wrk-[A-Za-z0-9_-]+/gu, "wrk-[redacted]");
}

export async function wereadRequest(body) {
  const key = getWeReadApiKey();
  if (!key) throw new Error("Missing WEREAD_API_KEY; initialize WeChat Reading through a local TTY first.");

  const response = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, skill_version: WEREAD_SKILL_VERSION }),
  });

  if (!response.ok) throw new Error(publicError(`WeChat Reading request failed: HTTP ${response.status}`));
  const data = await response.json();
  if (data.upgrade_info) throw new Error(`WeChat Reading skill upgrade required: ${publicError(data.upgrade_info.message || "unknown")}`);
  if (Number(data.errcode || 0) !== 0) throw new Error(publicError(`WeChat Reading error: ${data.errmsg || data.errcode}`));
  return data;
}
