/**
 * Pure analysis of a turn for the summary card: which checks the agent ran and how they went.
 * Reads only the tool calls already in the turn. The plugin never runs a check itself.
 */
import type { SummaryCheck } from "../../shared/chat";
import { errorText, firstErrorLine, shellCommand, type Item } from "../watchdog/turn";

const MAX_CHECKS = 10;

/** `CI=1 FOO=bar npm test` -> `npm test`. */
function stripEnv(segment: string): string {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}

/**
 * The last segment of the command (split on `&&`, `||`, `;`, `|` and new lines) that starts with
 * a check pattern, e.g. "npm test" from "sed -i … && npm test 2>&1 | tail". Null when none does.
 */
export function checkSegment(command: string, patterns: readonly string[]): string | null {
  const segments = command
    .split(/&&|\|\||;|\||\n/)
    .map((segment) => stripEnv(segment.trim().replace(/^\(+/, "")).replace(/\s*\d?>&?\d?\s*\S*$/, "").trim());
  let found: string | null = null;
  for (const segment of segments) {
    const hit = patterns.some((pattern) => {
      const p = pattern.trim();
      return p.length > 0 && (segment === p || segment.startsWith(`${p} `));
    });
    if (hit) found = segment;
  }
  return found;
}

export function matchesCheck(command: string, patterns: readonly string[]): boolean {
  return checkSegment(command, patterns) !== null;
}

function cut(text: string, max: number): string {
  const oneLine = text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Runner summary lines: "12 passed", "# pass 3", "test result: ok", "Tests: 4 passed". */
const SUMMARY_LINE =
  /(\b\d+\s+(passed|passing|failed|failures?|errors?)\b|^#\s*(pass|tests)\s+\d+|\btest result\b|no (errors|problems|issues)|all checks passed|found 0 errors)/i;
/** Weaker: a per-package or per-test "ok" line (go test, TAP). */
const OK_LINE = /^ok\b\s+\S+/i;

/** A line from passing output worth showing: the runner's count line, read from the end. */
export function passLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  for (const pattern of [SUMMARY_LINE, OK_LINE]) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] as string;
      if (pattern.test(line)) return cut(line, 160);
    }
  }
  return null;
}

function asRecord(value: unknown): Item | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Item) : null;
}

/**
 * Check commands the agent ran in the turn, in the order they last ran. A command run more than once
 * keeps its last result, which is the state the turn ended in.
 */
export function collectChecks(items: readonly unknown[], patterns: readonly string[]): SummaryCheck[] {
  const byCommand = new Map<string, SummaryCheck>();
  for (const value of items) {
    const item = asRecord(value);
    if (!item || item.type !== "tool_call") continue;
    if (item.status !== "completed" && item.status !== "failed") continue;
    const full = shellCommand(item);
    const command = full ? checkSegment(full, patterns) : null;
    if (!command) continue;
    const detail = asRecord(item.detail);
    const exitCode = typeof detail?.exitCode === "number" ? detail.exitCode : null;
    const passed = item.status === "completed" && (exitCode === null || exitCode === 0);
    const output = errorText(detail?.output);
    const line = passed
      ? passLine(output)
      : firstErrorLine(errorText(item.error) || output) || (exitCode !== null ? `exit code ${exitCode}` : null);
    const key = command.trim();
    byCommand.delete(key);
    byCommand.set(key, { command: cut(key, 120), passed, line: line ? cut(line, 160) : null });
  }
  return [...byCommand.values()].slice(-MAX_CHECKS);
}
