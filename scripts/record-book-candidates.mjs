#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { normalizeDisplayTitle } from "./lib/title-normalization.mjs";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const PIPELINE_PATH = path.join(DATA_DIR, "book-pipeline.csv");
const EXAMPLE_PATH = path.join(DATA_DIR, "book-pipeline.example.csv");
const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node scripts/record-book-candidates.mjs <candidates.json>");
  process.exit(1);
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { current += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { values.push(current); current = ""; }
    else current += char;
  }
  values.push(current);
  return values;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  const lines = text ? text.split(/\r?\n/u) : [];
  const headers = parseCsvLine(lines.shift() || "");
  const rows = lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
  return { headers, rows };
}

function rowKey(row) {
  const channel = String(row.source_channel || "").trim().toLowerCase();
  const sourceBookId = String(row.source_book_id || "").trim();
  if (sourceBookId) return `id:${channel}:${sourceBookId}`;
  return `title:${String(row.display_title || "").trim().toLowerCase()}|author:${String(row.author || "").trim().toLowerCase()}`;
}

function normalizeCandidate(candidate) {
  const sourceTitle = String(candidate.source_title || candidate.sourceTitle || candidate.title || candidate.display_title || "").trim();
  const displayTitle = normalizeDisplayTitle(sourceTitle, candidate.display_title || candidate.displayTitle || "");
  return {
    status: candidate.status || "candidate",
    priority: candidate.priority || "normal",
    display_title: displayTitle,
    source_title: sourceTitle,
    author: candidate.author || "",
    source_channel: candidate.source_channel || candidate.sourceChannel || "web",
    source_book_id: candidate.source_book_id || candidate.sourceBookId || "",
    category: candidate.category || "",
    rating: candidate.rating || "",
    rating_count: candidate.rating_count || candidate.ratingCount || "",
    reading_count: candidate.reading_count || candidate.readingCount || "",
    highlight_top_count: candidate.highlight_top_count || candidate.highlightTopCount || "",
    reviews_count: candidate.reviews_count || candidate.reviewsCount || "",
    resonance_score: candidate.resonance_score || candidate.resonanceScore || "",
    emotion_theme: candidate.emotion_theme || candidate.emotionTheme || "",
    selection_reason: candidate.selection_reason || candidate.selectionReason || "",
    video_project: candidate.video_project || candidate.videoProject || "",
    notes: candidate.notes || "",
  };
}

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PIPELINE_PATH)) fs.copyFileSync(EXAMPLE_PATH, PIPELINE_PATH);

const example = readCsv(EXAMPLE_PATH);
const current = readCsv(PIPELINE_PATH);
const headers = Array.from(new Set([...example.headers, ...current.headers]));
const rows = current.rows.map((row) => Object.fromEntries(headers.map((header) => [header, row[header] || ""])));
const byKey = new Map(rows.map((row, index) => [rowKey(row), index]));
const payload = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
const candidates = Array.isArray(payload) ? payload : payload.candidates;
if (!Array.isArray(candidates)) throw new Error("Candidates JSON must be an array or an object with a candidates array");

let added = 0;
let updated = 0;
for (const candidate of candidates) {
  const normalized = normalizeCandidate(candidate);
  if (!normalized.source_title || !normalized.author) continue;
  const key = rowKey(normalized);
  const existingIndex = byKey.get(key);
  if (existingIndex === undefined) {
    rows.push(Object.fromEntries(headers.map((header) => [header, normalized[header] || ""])));
    byKey.set(key, rows.length - 1);
    added += 1;
    continue;
  }
  const currentRow = rows[existingIndex];
  for (const header of headers) {
    if (normalized[header]) currentRow[header] = normalized[header];
  }
  updated += 1;
}

const output = `${[headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n")}\n`;
const tempPath = `${PIPELINE_PATH}.${process.pid}.tmp`;
fs.writeFileSync(tempPath, output, { mode: 0o600 });
fs.renameSync(tempPath, PIPELINE_PATH);
console.log(JSON.stringify({ added, updated, total: rows.length, path: PIPELINE_PATH }, null, 2));
