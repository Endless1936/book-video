import fs from "node:fs";
import path from "node:path";

export function createBatchState(books, batchId, now = new Date().toISOString()) {
  return { schemaVersion: 1, batchId, books: [...books], currentPosition: 0, items: books.map((book) => ({ book, status: "pending", failedStage: null, resumeRecommendation: "" })), createdAt: now, updatedAt: now, completedAt: null };
}

export function advanceBatch(state, result, now = new Date().toISOString()) {
  if (state.currentPosition >= state.items.length) return state;
  const items = state.items.map((item, index) => index === state.currentPosition ? { ...item, ...result } : item);
  const currentPosition = state.currentPosition + 1;
  return { ...state, items, currentPosition, updatedAt: now, completedAt: currentPosition === items.length ? now : null };
}

export function summarizeBatch(state) {
  return { status: state.currentPosition >= state.items.length ? "complete" : "in_progress", batchId: state.batchId, currentPosition: state.currentPosition, items: state.items.map((item) => ({ ...item })) };
}

export function writeBatchState(batchDirectory, state) {
  fs.mkdirSync(batchDirectory, { recursive: true });
  const destination = path.join(batchDirectory, `${state.batchId}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, destination); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}

export function readBatchState(batchDirectory, batchId) {
  return JSON.parse(fs.readFileSync(path.join(batchDirectory, `${batchId}.json`), "utf8"));
}
