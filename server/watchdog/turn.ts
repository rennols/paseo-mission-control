/**
 * Pure analysis of one ended turn: the facts the watchdog and the Needs you list use. No Paseo
 * calls and no I/O, so it is unit-tested against payload shapes recorded in step 0.
 *
 * Timeline items are read as `unknown` on purpose: providers fill `error` and `detail` differently
 * (Claude gives `status: "failed"` with `error.content`; others may give `exitCode`), and a shape we
 * don't recognise must never throw.
 */

export interface TurnFailure {
  /** What failed, normalised: the shell command or the tool name. */
  command: string;
  /** First meaningful error line, normalised. */
  errorLine: string;
  /** `command — errorLine`, the key the watchdog counts repeats of. */
  signature: string;
  /** The same, for people: unnormalised, cut to 160 characters. */
  display: string;
}

export interface TurnFacts {
  /** False when Paseo started the turn itself, e.g. a parent woken when its worker finished. */
  userStarted: boolean;
  /** Distinct failures in the turn, in order. */
  failures: TurnFailure[];
  /** Completed edit or write tool calls. Shell commands that change files are caught by git. */
  fileEdits: number;
  /** One line on the latest thing the agent did. */
  latestActivity: string | null;
  /** The final assistant message, trimmed. */
  finalText: string | null;
  /** The final message ends by asking the user something. */
  asksQuestion: string | null;
}

type Item = Record<string, unknown>;

function asRecord(value: unknown): Item | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Item) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Collects text from the shapes providers use for an error: string, { content }, { message }, arrays of blocks. */
export function errorText(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => errorText(part, depth + 1)).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return String(value);
  for (const key of ["content", "message", "text", "stderr", "output", "error"]) {
    const text = errorText(record[key], depth + 1);
    if (text) return text;
  }
  return "";
}

const NOISE_LINE = /^(exit code:? -?\d+|command failed|error:?\s*$|\s*$|>|npm err! *$|-+$|=+$)/i;
const ERROR_HINT =
  /(error|fail|exception|cannot|can't|not found|no such|undefined|denied|refused|timed? ?out|expected|assert|panic|traceback|fatal|invalid|missing|unexpected)/i;

/** Lines that start like a test runner's or compiler's failure report: preferred over any other. */
const STRONG_ERROR =
  /^(not ok\b|fail(ed)?\b|--- fail|[✗×✕]|\w*(error|exception)\b|panic:|traceback|fatal:|e\s{2,}\S|\S+:\d+(:\d+)?:\s*error)/i;

/** First line that reads like a failure report, else like an error, else the first line with content. */
export function firstErrorLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE_LINE.test(line));
  return lines.find((line) => STRONG_ERROR.test(line)) ?? lines.find((line) => ERROR_HINT.test(line)) ?? lines[0] ?? "";
}

/**
 * Strips what changes between identical failures: paths, numbers, hashes, durations, quoted
 * temp names. "FAIL src/a.test.ts (2.31 s)" and "FAIL src/a.test.ts (1.9 s)" give the same key.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u001b\[[0-9;]*m/g, "") // ANSI colours
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@+-]+)+[\\/]?/gi, (path) => {
      // Keep the file name: "/home/a/src/x.test.ts" -> "x.test.ts". It tells tests apart.
      const parts = path.split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] ?? "<path>";
    })
    .replace(/\b[0-9a-f]{7,64}\b/g, "<hash>")
    .replace(/\b\d+(?:[.:]\d+)*\s*(?:ms|s|sec|secs|seconds|m|min)?\b/g, "<n>")
    .replace(/["'`][^"'`\n]{0,80}["'`]/g, (quoted) => (/\d/.test(quoted) ? "<q>" : quoted))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function cut(text: string, max: number): string {
  const oneLine = text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ""))
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function shellCommand(item: Item): string | null {
  const detail = asRecord(item.detail);
  if (detail?.type === "shell") return str(detail.command);
  const input = asRecord(detail?.input) ?? asRecord(item.input);
  return str(input?.command);
}

/** A failed tool call, or a shell call that completed with a non-zero exit code. */
function failureOf(item: Item): TurnFailure | null {
  if (item.type !== "tool_call") return null;
  const detail = asRecord(item.detail);
  const exitCode = typeof detail?.exitCode === "number" ? detail.exitCode : null;
  const failed = item.status === "failed" || (item.status === "completed" && exitCode !== null && exitCode !== 0);
  if (!failed) return null;

  const command = shellCommand(item) ?? str(item.name) ?? "tool";
  const text = errorText(item.error) || errorText(detail?.output) || errorText(asRecord(detail?.output));
  const line = firstErrorLine(text) || (exitCode !== null ? `exit code ${exitCode}` : "failed");
  const normalisedCommand = normalise(command);
  const errorLine = normalise(line);
  return {
    command: normalisedCommand,
    errorLine,
    signature: `${normalisedCommand} — ${errorLine}`,
    display: cut(`${command}: ${line}`, 160),
  };
}

function isFileEdit(item: Item): boolean {
  if (item.type !== "tool_call" || item.status !== "completed") return false;
  const kind = asRecord(item.detail)?.type;
  if (kind === "edit" || kind === "write") return true;
  return /^(apply_patch|edit|write|multiedit|str_replace|create_file)$/i.test(str(item.name) ?? "");
}

function describe(item: Item): string | null {
  switch (item.type) {
    case "assistant_message":
      return str(item.text) ? cut(str(item.text) as string, 120) : null;
    case "tool_call": {
      const detail = asRecord(item.detail);
      const status = item.status === "failed" ? "Failed" : item.status === "running" ? "Running" : "Ran";
      const command = shellCommand(item);
      if (command) return cut(`${status} ${command}`, 120);
      const file = str(detail?.filePath);
      if (file) return cut(`${detail?.type === "read" ? "Read" : "Edited"} ${file.split(/[\\/]/).pop()}`, 120);
      return cut(`${status} ${str(item.name) ?? "a tool"}`, 120);
    }
    case "error":
      return str(item.message) ? cut(`Error: ${item.message as string}`, 120) : null;
    default:
      return null;
  }
}

/**
 * The question the final message ends with, if any: its last sentence ends with "?". Questions
 * inside code blocks don't count. Rhetorical questions will slip through; the user can dismiss.
 */
export function trailingQuestion(text: string | null): string | null {
  if (!text) return null;
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ").trim();
  if (!withoutCode.endsWith("?")) return null;
  const lastParagraph = withoutCode.split(/\n\s*\n/).pop() ?? withoutCode;
  const sentences = lastParagraph.split(/(?<=[.!?])\s+/);
  const question = sentences[sentences.length - 1] ?? lastParagraph;
  return cut(question, 200);
}

export function analyseTurn(items: readonly unknown[]): TurnFacts {
  const records = items.map(asRecord).filter((item): item is Item => item !== null);
  const failures: TurnFailure[] = [];
  const seen = new Set<string>();
  let fileEdits = 0;
  let latestActivity: string | null = null;
  let finalText: string | null = null;

  for (const item of records) {
    const failure = failureOf(item);
    if (failure && !seen.has(failure.signature)) {
      seen.add(failure.signature);
      failures.push(failure);
    }
    if (isFileEdit(item)) fileEdits += 1;
    const description = describe(item);
    if (description) latestActivity = description;
    if (item.type === "assistant_message" && str(item.text)?.trim()) finalText = (item.text as string).trim();
  }

  return {
    userStarted: records.some((item) => item.type === "user_message"),
    failures,
    fileEdits,
    latestActivity,
    finalText,
    asksQuestion: trailingQuestion(finalText),
  };
}
