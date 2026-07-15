import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  jianyingVoice: "", jianyingApp: "剪映专业版", jianyingExportDir: "", lastBgm: "",
  defaultTheme: "", defaultAudience: "年轻读者", defaultBgmPolicy: "reuse-last",
  automaticSelectionExclusion: "completed", stageTimeoutMs: 600000,
  stageRetryLimit: Object.freeze({ selected: 3, researched: 3, scripted: 3, illustrated: 3, voiced: 3, timed: 3, rendered: 3, verified: 3 }),
  jianyingCapability: Object.freeze({ unicodeTextCommit: false, export: false, smokeTestedAt: "" }),
});

export function validateConfig(value, { requireCapability = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object");
  const config = { ...DEFAULT_CONFIG, ...value, stageRetryLimit: { ...DEFAULT_CONFIG.stageRetryLimit, ...(value.stageRetryLimit || {}) }, jianyingCapability: { ...DEFAULT_CONFIG.jianyingCapability, ...(value.jianyingCapability || {}) } };
  for (const field of ["jianyingVoice", "jianyingApp", "jianyingExportDir", "lastBgm", "defaultTheme", "defaultAudience", "defaultBgmPolicy", "automaticSelectionExclusion"]) if (typeof config[field] !== "string") throw new Error(`${field} must be a string`);
  if (!config.jianyingApp.trim()) throw new Error("jianyingApp must not be empty");
  if (!Number.isInteger(config.stageTimeoutMs) || config.stageTimeoutMs <= 0) throw new Error("stageTimeoutMs must be a positive integer");
  for (const [stage, limit] of Object.entries(config.stageRetryLimit)) if (!Number.isInteger(limit) || limit < 1) throw new Error(`stageRetryLimit.${stage} must be a positive integer`);
  if (requireCapability && !(config.jianyingCapability.unicodeTextCommit === true && config.jianyingCapability.export === true && config.jianyingCapability.smokeTestedAt)) throw new Error("Jianying capability probe for Unicode text commit/export has not passed");
  return config;
}

export function readProductionConfig(root, options) {
  const file = path.join(root, ".book-video-config.json");
  let parsed = {};
  if (fs.existsSync(file)) { try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw new Error(`Malformed .book-video-config.json: ${error.message}`); } }
  return validateConfig(parsed, options);
}
