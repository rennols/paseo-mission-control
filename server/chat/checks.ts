/**
 * Pure analysis of a turn for the summary card: which checks the agent ran and how they went.
 * Reads only the tool calls already in the turn. The plugin never runs a check itself.
 */
import type { SummaryCheck } from "../../shared/chat";
import { checkSegment, cut, failureInOutput, passLine } from "../../shared/check-output";
import { errorText, firstErrorLine, shellCommand, type Item } from "../watchdog/turn";

export { checkSegment, failureInOutput, matchesCheck, passLine } from "../../shared/check-output";

const MAX_CHECKS = 10;

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
    const output = errorText(detail?.output);
    const exitedOk = item.status === "completed" && (exitCode === null || exitCode === 0);
    const shownFailure = exitedOk ? failureInOutput(output) : null;
    const passed = exitedOk && shownFailure === null;
    const line =
      shownFailure ??
      (passed
        ? passLine(output)
        : firstErrorLine(errorText(item.error) || output) || (exitCode !== null ? `exit code ${exitCode}` : null));
    const key = command.trim();
    byCommand.delete(key);
    byCommand.set(key, { command: cut(key, 120), passed, line: line ? cut(line, 160) : null });
  }
  return [...byCommand.values()].slice(-MAX_CHECKS);
}
