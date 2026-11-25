/**
 * Test and edit cards (PRD: Chat, Test and edit cards).
 *
 * A finished shell call that runs a check command becomes a test card: the command, a passed or
 * failed pill, counts and duration, and only the failing tests with their first error line. A
 * finished file edit becomes an edit card: the path, lines added and removed, and the first lines
 * of the diff.
 *
 * Both are built in the app by a timeline transformer from the tool call itself: the output the
 * agent already got and the diff its edit tool reported. The plugin never runs a check or reads a
 * file for them. Anything that can't be read keeps Paseo's own row (the transformer returns
 * undefined), never an empty card. Because they are derived on render, they come back after a
 * daemon restart, unlike appended rows.
 */
import { z } from "zod";
import { checkSegment, failureInOutput } from "./check-output";
import { diffFromContent, diffFromStrings, diffFromUnified, type EditDiff } from "./edit-diff";
import { parseTestOutput } from "./test-output";

export const TEST_CARD_KIND = "test-card";
export const TEST_CARD_VERSION = 1;
export const EDIT_CARD_KIND = "edit-card";
export const EDIT_CARD_VERSION = 1;

/** Diff lines shown before Show all lines. */
export const EDIT_LINES_SHOWN = 6;
/** Output kept for Show full output: the end of it, where runners print failures and counts. */
export const MAX_OUTPUT_CHARS = 32_000;

export const TestCardSchema = z.object({
  command: z.string(),
  passed: z.boolean(),
  exitCode: z.number().int().nullable(),
  counts: z
    .object({
      passed: z.number().int().nullable(),
      failed: z.number().int().nullable(),
      skipped: z.number().int().nullable(),
      total: z.number().int().nullable(),
      unit: z.enum(["tests", "packages"]),
    })
    .nullable(),
  durationMs: z.number().nullable(),
  failures: z.array(z.object({ name: z.string(), line: z.string().nullable() })),
  moreFailures: z.number().int().nonnegative(),
  output: z.string(),
  /** Characters cut from the start of `output`. */
  outputCut: z.number().int().nonnegative(),
});
export type TestCard = z.output<typeof TestCardSchema>;

export const EditCardSchema = z.object({
  path: z.string(),
  /** "write" when the tool wrote the whole file: Paseo doesn't say what was there before. */
  mode: z.enum(["edit", "write"]),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  lines: z.array(z.object({ kind: z.enum(["add", "del", "ctx", "gap"]), text: z.string() })),
  moreLines: z.number().int().nonnegative(),
});
export type EditCard = z.output<typeof EditCardSchema>;

export interface ToolCardConfig {
  testCards: boolean;
  editCards: boolean;
  checkPatterns: readonly string[];
}

/** A tool call row as the transformer sees it. Read loosely: providers fill it differently. */
export interface ToolCallLike {
  type: string;
  status?: unknown;
  detail?: unknown;
}

type CardItem =
  | { type: "plugin"; kind: typeof TEST_CARD_KIND; version: number; data: TestCard }
  | { type: "plugin"; kind: typeof EDIT_CARD_KIND; version: number; data: EditCard };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function testCard(item: ToolCallLike, patterns: readonly string[]): TestCard | null {
  if (item.status !== "completed" && item.status !== "failed") return null;
  const detail = record(item.detail);
  if (detail?.type !== "shell") return null;
  const full = text(detail.command);
  const command = full ? checkSegment(full, patterns) : null;
  if (!command) return null;
  const output = text(detail.output) ?? "";
  const parsed = parseTestOutput(output);
  // PRD: output that can't be parsed keeps Paseo's normal row.
  if (parsed.counts === null && parsed.failures.length === 0) return null;
  const exitCode = typeof detail.exitCode === "number" ? detail.exitCode : null;
  const exitedOk = item.status === "completed" && (exitCode === null || exitCode === 0);
  const passed =
    exitedOk && failureInOutput(output) === null && (parsed.counts?.failed ?? 0) === 0 && parsed.failures.length === 0;
  const outputCut = Math.max(0, output.length - MAX_OUTPUT_CHARS);
  return {
    command,
    passed,
    exitCode,
    counts: parsed.counts,
    durationMs: parsed.durationMs,
    failures: parsed.failures,
    moreFailures: parsed.moreFailures,
    output: outputCut > 0 ? output.slice(outputCut) : output,
    outputCut,
  };
}

export function editCard(item: ToolCallLike): EditCard | null {
  if (item.status !== "completed") return null;
  const detail = record(item.detail);
  if (detail?.type !== "edit" && detail?.type !== "write") return null;
  const path = text(detail.filePath);
  if (!path) return null;
  let diff: EditDiff | null = null;
  if (detail.type === "edit") {
    const unified = text(detail.unifiedDiff);
    const before = text(detail.oldString);
    const after = text(detail.newString);
    if (unified && unified.trim()) diff = diffFromUnified(unified);
    else if (before !== null && after !== null) diff = diffFromStrings(before, after);
  } else {
    const content = text(detail.content);
    if (content !== null) diff = diffFromContent(content);
  }
  if (!diff || (diff.added === 0 && diff.removed === 0)) return null;
  return {
    path,
    mode: detail.type === "write" ? "write" : "edit",
    added: diff.added,
    removed: diff.removed,
    lines: diff.lines,
    moreLines: diff.moreLines,
  };
}

/**
 * The transformer body: a card for a finished test command or file edit, else undefined so Paseo
 * keeps its own row. Running calls keep Paseo's live row until they finish.
 */
export function toolCardFor(
  item: ToolCallLike,
  phase: "streaming" | "complete",
  config: ToolCardConfig,
): { items: CardItem[] } | undefined {
  if (phase !== "complete" || item.type !== "tool_call") return undefined;
  if (config.testCards) {
    const card = testCard(item, config.checkPatterns);
    if (card) return { items: [{ type: "plugin", kind: TEST_CARD_KIND, version: TEST_CARD_VERSION, data: card }] };
  }
  if (config.editCards) {
    const card = editCard(item);
    if (card) return { items: [{ type: "plugin", kind: EDIT_CARD_KIND, version: EDIT_CARD_VERSION, data: card }] };
  }
  return undefined;
}

/** "1.2 s", "340 ms", "2 min 5 s". */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** "1 failed · 12 passed · 1 skipped · 1.2 s"; "3 packages ok · 0.4 s". */
export function testSummaryText(card: Pick<TestCard, "counts" | "durationMs">): string {
  const parts: string[] = [];
  const counts = card.counts;
  if (counts?.unit === "packages") {
    if (counts.failed) parts.push(`${counts.failed} ${counts.failed === 1 ? "package" : "packages"} failed`);
    if (counts.passed) parts.push(`${counts.passed} ${counts.passed === 1 ? "package" : "packages"} ok`);
  } else if (counts) {
    if (counts.failed) parts.push(`${counts.failed} failed`);
    if (counts.passed !== null) parts.push(`${counts.passed} passed`);
    if (counts.skipped) parts.push(`${counts.skipped} skipped`);
    if (counts.passed === null && counts.total) parts.push(`${counts.total} total`);
  }
  if (card.durationMs !== null) parts.push(durationText(card.durationMs));
  return parts.join(" · ");
}

/** The path as Paseo shows it in its own rows: relative to the agent's folder when inside it. */
export function displayPath(filePath: string, cwd: string | null | undefined): string {
  if (!cwd) return filePath;
  const base = cwd.replace(/[\\/]+$/, "");
  if (filePath === base) return ".";
  for (const sep of ["/", "\\"]) {
    if (filePath.startsWith(base + sep)) return filePath.slice(base.length + 1);
  }
  return filePath;
}

/**
 * Keeps a diff line's indentation on screen: a one-line Text collapses runs of spaces on the web,
 * so leading spaces become no-break spaces and tabs become two.
 */
export function keepIndent(text: string): string {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? "";
  return indent.replace(/\t/g, "  ").replace(/ /g, "\u00a0") + text.slice(indent.length);
}
