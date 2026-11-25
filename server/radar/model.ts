/**
 * Collision radar, pure parts: parsing `git diff -U0` hunks, deciding whether two agents' edits to
 * one file would conflict, and the Needs you card text. No git, no Paseo: tested in
 * test/radar.test.ts.
 */

/** One changed range from `git diff -U0`, in the old file's line numbers. */
export interface Hunk {
  /** First old line. For a pure insertion, the line it goes after (0 = top of the file). */
  start: number;
  /** Old lines replaced or removed. 0 for a pure insertion. */
  count: number;
  /** Git's function context after the second `@@`, or null. */
  header: string | null;
}

/** Parses the `@@ -a,b +c,d @@ header` lines of a unified diff. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of diff.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (!match) continue;
    const header = (match[3] ?? "").trim();
    hunks.push({ start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]), header: header || null });
  }
  return hunks;
}

/** Old-side span: changed lines [lo, hi]; an insertion after line n is the point n + 0.5. */
function span(hunk: Hunk): { lo: number; hi: number } {
  return hunk.count === 0 ? { lo: hunk.start + 0.5, hi: hunk.start + 0.5 } : { lo: hunk.start, hi: hunk.start + hunk.count - 1 };
}

export interface Overlap {
  /** First and last line of the overlapping area, in the shared starting version. */
  from: number;
  to: number;
  /** The enclosing function, from git's hunk header, when git found one. */
  header: string | null;
}

/**
 * Where two sets of changes to the same starting file touch. Like git's merge, changes that
 * overlap or sit on adjacent lines count: git reports those as a conflict.
 */
export function overlaps(a: readonly Hunk[], b: readonly Hunk[]): Overlap[] {
  const found: Overlap[] = [];
  for (const left of a) {
    const x = span(left);
    for (const right of b) {
      const y = span(right);
      if (x.lo <= y.hi + 1 && y.lo <= x.hi + 1) {
        found.push({
          from: Math.max(1, Math.floor(Math.min(x.lo, y.lo))),
          to: Math.max(1, Math.ceil(Math.max(x.hi, y.hi))),
          header: left.header ?? right.header,
        });
      }
    }
  }
  return found.sort((p, q) => p.from - q.from);
}

/** Blob ids of one path: each agent's starting version and current version. Undefined = no file. */
export interface FileBlobs {
  baseA: string | undefined;
  headA: string | undefined;
  baseB: string | undefined;
  headB: string | undefined;
}

export type FileVerdict =
  /** No conflict possible: same result, or one agent started from the other's result. */
  | { kind: "skip" }
  /** Git would conflict without looking at lines: both created it, or one deleted what the other changed. */
  | { kind: "structural"; reason: "both created" | "deleted on one side" | "created on one side" }
  /** Compare line ranges, both measured from A's starting version. */
  | { kind: "compare" };

export function classifyFile(blobs: FileBlobs): FileVerdict {
  const { baseA, headA, baseB, headB } = blobs;
  if (headA === headB) return { kind: "skip" };
  // One side started from the other's result (it was merged in or copied): its edits sit on top.
  if (headA === baseB || headB === baseA) return { kind: "skip" };
  if (headA === undefined || headB === undefined) return { kind: "structural", reason: "deleted on one side" };
  if (baseA === undefined && baseB === undefined) return { kind: "structural", reason: "both created" };
  if (baseA === undefined || baseB === undefined) return { kind: "structural", reason: "created on one side" };
  return { kind: "compare" };
}

export interface FileCollision {
  path: string;
  /** "lines": git would likely conflict. "file": both changed it, in different places. */
  level: "lines" | "file";
  overlaps: Overlap[];
  reason: string | null;
}

/** One card per pair of agents, whichever found it first. */
export function pairKey(a: string, b: string): string {
  return `collision:${[a, b].sort().join("|")}`;
}

/** What a dismissal remembers: the files the card listed. */
export function signature(files: readonly FileCollision[]): string {
  return files
    .map((file) => file.path)
    .sort()
    .join("\n");
}

/** True when `next` lists a file the dismissed card didn't. */
export function reachesNewFile(dismissed: string, next: string): boolean {
  const before = new Set(dismissed.split("\n"));
  return next.split("\n").some((file) => !before.has(file));
}

function lines(overlap: Overlap): string {
  return overlap.from === overlap.to ? `line ${overlap.from}` : `lines ${overlap.from}–${overlap.to}`;
}

function shortHeader(header: string): string {
  const flat = header.replace(/\s+/g, " ").replace(/\s*[{:]$/, "").trim();
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

export function describeFile(file: FileCollision): string {
  if (file.reason) return `${file.path}: ${file.reason}`;
  if (file.level === "file" || file.overlaps.length === 0) return `${file.path}: same file, different lines`;
  const first = file.overlaps[0] as Overlap;
  const more = file.overlaps.length > 1 ? ` (+${file.overlaps.length - 1} more)` : "";
  const where = first.header ? ` in ${shortHeader(first.header)}` : "";
  return `${file.path} ${lines(first)}${more}${where}`;
}

/** Card title and detail. The detail fits the card's three lines. */
export function describeCollision(
  other: { title: string; branch: string | null },
  files: readonly FileCollision[],
): { title: string; detail: string } {
  const strong = files.some((file) => file.level === "lines");
  const where = other.branch ? ` on ${other.branch}` : "";
  const title = `${strong ? "Same lines as" : "Same file as"} ${other.title}${where}`;
  const sorted = [...files].sort((p, q) => (p.level === q.level ? p.path.localeCompare(q.path) : p.level === "lines" ? -1 : 1));
  const shown = sorted.length > 3 ? sorted.slice(0, 2) : sorted;
  const rows = shown.map(describeFile);
  if (sorted.length > shown.length) rows.push(`+${sorted.length - shown.length} more files`);
  return { title, detail: rows.join("\n") };
}
