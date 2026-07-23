import fs from "node:fs";
import path from "node:path";

const DIAGNOSTIC_PATH = path.join("tmp", "last-workflow-diagnostic.json");
let installed = false;
let emitted = false;

export class WorkflowError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = options.code;
    this.recoverable = options.recoverable;
    this.nextActions = options.nextActions;
    this.details = options.details;
  }
}

function inferCode(message) {
  if (/usage:/iu.test(message)) return "invalid_arguments";
  if (/missing|not found|no shared|does not exist/iu.test(message)) return "missing_input";
  if (/script|正文|字幕/iu.test(message)) return "invalid_script";
  if (/ffmpeg|ffprobe|whisper|hyperframes|npx/iu.test(message)) return "dependency_or_media_failure";
  return "workflow_step_failed";
}

export function normalizeWorkflowDiagnostic(error, context = {}) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const nextActions = normalized.nextActions || context.nextActions || [
    "Inspect the referenced inputs and command output.",
    "Correct the recoverable cause, then rerun the same command.",
    "Keep the last valid artifact active until the rerun passes.",
  ];
  return {
    schemaVersion: 1,
    status: "action_required",
    command: context.command || path.basename(process.argv[1] || "unknown"),
    stage: context.stage || "unknown",
    code: normalized.code || inferCode(normalized.message),
    recoverable: normalized.recoverable ?? context.recoverable ?? true,
    error: normalized.message,
    details: normalized.details || context.details || {},
    nextActions,
    recordedAt: new Date().toISOString(),
  };
}

function writeDiagnostic(diagnostic, root) {
  const destination = path.join(root, DIAGNOSTIC_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return destination;
}

export function clearWorkflowDiagnostic(root = process.cwd()) {
  fs.rmSync(path.join(root, DIAGNOSTIC_PATH), { force: true });
}

export function readWorkflowDiagnostic(root = process.cwd()) {
  const filePath = path.join(root, DIAGNOSTIC_PATH);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function reportWorkflowFailure(error, context = {}) {
  if (emitted) return null;
  emitted = true;
  const diagnostic = normalizeWorkflowDiagnostic(error, context);
  const root = context.root || process.cwd();
  const childDiagnostic = readWorkflowDiagnostic(root);
  if (childDiagnostic && childDiagnostic.command !== diagnostic.command) {
    console.error(diagnostic.error);
    console.error(`BOOK_VIDEO_DIAGNOSTIC ${JSON.stringify({
      ...childDiagnostic,
      parentFailure: {
        command: diagnostic.command,
        stage: diagnostic.stage,
        error: diagnostic.error,
      },
      diagnosticPath: path.join(root, DIAGNOSTIC_PATH),
    })}`);
    process.exitCode = 1;
    return childDiagnostic;
  }
  let diagnosticPath = null;
  try {
    diagnosticPath = writeDiagnostic(diagnostic, root);
  } catch (writeError) {
    diagnostic.details.diagnosticWriteError = writeError.message;
  }
  console.error(diagnostic.error);
  console.error(`BOOK_VIDEO_DIAGNOSTIC ${JSON.stringify({
    ...diagnostic,
    diagnosticPath,
  })}`);
  process.exitCode = 1;
  return diagnostic;
}

export function installWorkflowDiagnostics(context = {}) {
  if (installed) return;
  installed = true;
  try {
    clearWorkflowDiagnostic(context.root || process.cwd());
  } catch {}
  process.once("uncaughtException", (error) => reportWorkflowFailure(error, context));
  process.once("unhandledRejection", (error) => reportWorkflowFailure(error, context));
}
