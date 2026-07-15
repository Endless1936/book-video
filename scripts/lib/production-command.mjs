const MODES = new Set(["book", "auto", "batch", "resume"]);

function usage(message = "") {
  const prefix = message ? `${message}. ` : "";
  throw new Error(`${prefix}Usage: auto-produce.mjs book <title> | auto [--theme <theme>] | batch <title...> | resume <title>`);
}

export function parseProductionCommand(args) {
  const [mode, ...rest] = args;
  if (!MODES.has(mode)) usage();
  if (mode === "auto") {
    if (rest.length === 0) return { mode, books: [], theme: "" };
    if (rest[0] !== "--theme") usage("Unknown auto option");
    if (!rest[1] || rest.length !== 2) usage("--theme requires a value");
    return { mode, books: [], theme: rest[1].trim() };
  }
  if (mode === "batch" && rest[0] === "--resume") {
    if (rest.length !== 2 || !rest[1].trim()) usage("batch --resume requires a batch ID");
    return { mode, books: [], theme: "", batchId: rest[1].trim() };
  }
  const books = rest.map((item) => item.trim()).filter(Boolean);
  if ((mode === "book" || mode === "resume") && books.length !== 1) {
    usage(`${mode} requires exactly one book`);
  }
  if (mode === "batch" && books.length === 0) usage("batch requires at least one book");
  return { mode, books, theme: "" };
}
