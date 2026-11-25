/**
 * Diff lines for the edit card, built from what the edit tool call already carries: a unified
 * diff, or the old and new strings, or a written file's content. Pure and synchronous: it runs in
 * the app's timeline transformer. It never reads the file.
 */

export interface DiffLine {
  /** "gap" stands for unchanged lines left out between changes. */
  kind: "add" | "del" | "ctx" | "gap";
  text: string;
}

export interface EditDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Diff lines beyond MAX_DIFF_LINES, not kept. */
  moreLines: number;
}

/** Keeps the card's data small; Show all lines shows these. */
export const MAX_DIFF_LINES = 400;
const MAX_LINE_LENGTH = 400;
/** Unchanged lines kept on each side of a change. */
const CONTEXT = 2;
/** Above this many cells, skip the line-by-line match and show old then new. */
const MAX_LCS_CELLS = 250_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function line(kind: DiffLine["kind"], text: string): DiffLine {
  return { kind, text: text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH - 1)}…` : text };
}

function finish(lines: DiffLine[]): EditDiff {
  let added = 0;
  let removed = 0;
  for (const entry of lines) {
    if (entry.kind === "add") added += 1;
    else if (entry.kind === "del") removed += 1;
  }
  return { lines: lines.slice(0, MAX_DIFF_LINES), added, removed, moreLines: Math.max(0, lines.length - MAX_DIFF_LINES) };
}

/** Drops unchanged lines further than CONTEXT from any change, leaving one gap marker per run. */
function trimContext(lines: DiffLine[]): DiffLine[] {
  const keep = lines.map((entry) => entry.kind !== "ctx");
  for (const [index, entry] of lines.entries()) {
    if (entry.kind === "ctx") continue;
    for (let offset = 1; offset <= CONTEXT; offset += 1) {
      if (index - offset >= 0) keep[index - offset] = true;
      if (index + offset < lines.length) keep[index + offset] = true;
    }
  }
  const out: DiffLine[] = [];
  for (const [index, entry] of lines.entries()) {
    if (keep[index]) out.push(entry);
    else if (out.length > 0 && out.at(-1)?.kind !== "gap" && keep.slice(index).some(Boolean)) out.push({ kind: "gap", text: "" });
  }
  return out;
}

/** Lines of a unified diff, headers dropped, `@@` lines turned into gap markers. */
export function diffFromUnified(diff: string): EditDiff {
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const raw of splitLines(diff)) {
    if (raw.startsWith("@@")) {
      if (out.length > 0) out.push({ kind: "gap", text: "" });
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    if (raw.startsWith("diff --git")) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith("+")) out.push(line("add", raw.slice(1)));
    else if (raw.startsWith("-")) out.push(line("del", raw.slice(1)));
    else out.push(line("ctx", raw.startsWith(" ") ? raw.slice(1) : raw));
  }
  return finish(out);
}

/** A line diff of two strings (longest common subsequence), unchanged lines trimmed to context. */
export function diffFromStrings(before: string, after: string): EditDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle: DiffLine[] = [];
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const text of midA) middle.push(line("del", text));
    for (const text of midB) middle.push(line("add", text));
  } else {
    // lengths[i][j] = LCS of midA[i..] and midB[j..].
    const width = midB.length + 1;
    const lengths = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        lengths[i * width + j] =
          midA[i] === midB[j]
            ? (lengths[(i + 1) * width + j + 1] as number) + 1
            : Math.max(lengths[(i + 1) * width + j] as number, lengths[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        middle.push(line("ctx", midA[i] as string));
        i += 1;
        j += 1;
      } else if (i < midA.length && (j === midB.length || (lengths[(i + 1) * width + j] as number) >= (lengths[i * width + j + 1] as number))) {
        middle.push(line("del", midA[i] as string));
        i += 1;
      } else {
        middle.push(line("add", midB[j] as string));
        j += 1;
      }
    }
  }
  const all = [
    ...a.slice(0, start).map((text) => line("ctx", text)),
    ...middle,
    ...a.slice(endA).map((text) => line("ctx", text)),
  ];
  return finish(trimContext(all));
}

/** A whole file written in one call: every line is added. */
export function diffFromContent(content: string): EditDiff {
  return finish(splitLines(content).map((text) => line("add", text)));
}
