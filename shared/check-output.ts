/**
 * Reading check commands and their output: which part of a shell command is a check, and whether
 * its output shows a pass or a failure. Pure functions on text the agent already got, shared by the
 * daemon (turn summary card) and the app (test card). Nothing here runs a command.
 */

/** `CI=1 FOO=bar npm test` -> `npm test`. */
export function stripEnv(segment: string): string {
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

export function cut(text: string, max: number): string {
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

/**
 * Failure signs in output that exited 0, which happens when the agent pipes a check through
 * `tail` or `grep`: a non-zero fail count, a TAP "not ok", a runner's FAIL line, or an
 * `exit: N` the agent echoed from PIPESTATUS. Returns the line that shows it.
 */
export function failureInOutput(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  const signs = [
    /^#\s*fail\s+[1-9]\d*\b/i,
    /\b[1-9]\d*\s+(failed|failing|failures?)\b/i,
    /^not ok\b/i,
    /^(FAIL|FAILED)\b/,
    /^--- FAIL\b/,
    /\bexit(?: code)?:?\s*[1-9]\d*\s*$/i,
    /^test result: FAILED/i,
  ];
  for (const sign of signs) {
    const line = lines.find((candidate) => sign.test(candidate));
    if (line) return cut(line, 160);
  }
  return null;
}

