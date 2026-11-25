/**
 * Pure rules for the overnight report: which window to show and what each queue run did, changed
 * and needs. No Paseo, git or timers here, so every rule is unit tested (test/report-model.test.ts).
 *
 * Inputs are what Mission Control already stores: queue tasks, Review inbox items, open Needs you
 * cards and turn summaries. Nothing here runs a command or reads the network.
 */
import type { SummaryCheck, TurnSummary } from "../../shared/chat";
import type { NeedsItem } from "../../shared/live";
import type { InboxItem, QueueTask } from "../../shared/queue";
import type { OvernightReport, ReportNeed, ReportRun } from "../../shared/report";

export interface ReportWindow {
  from: number;
  to: number;
  inProgress: boolean;
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function at(day: Date, minutes: number, addDays = 0): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + addDays, Math.floor(minutes / 60), minutes % 60).getTime();
}

/**
 * The most recent overnight window that has started, in the host's local time. In the morning
 * that is last night's; during the night it is tonight's so far (`inProgress`). A window whose end
 * is at or before its start runs past midnight; equal times mean a whole day. Built from calendar
 * dates, so a daylight saving change makes that night an hour shorter or longer, not shifted.
 */
export function overnightWindow(now: number, start: string, end: string): ReportWindow {
  const startMinutes = clockMinutes(start);
  const endMinutes = clockMinutes(end);
  const crossesMidnight = endMinutes <= startMinutes;
  const today = new Date(now);
  let day = today;
  if (at(today, startMinutes) > now) day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12);
  const from = at(day, startMinutes);
  const to = at(day, endMinutes, crossesMidnight ? 1 : 0);
  return { from, to, inProgress: now < to };
}

/** True when the task ran (or was running) at some point inside the window. */
export function ranInWindow(task: QueueTask, window: ReportWindow, now: number): boolean {
  if (task.startedAt === null) return false;
  const until = Math.min(window.to, now);
  const ended = task.finishedAt ?? now;
  return task.startedAt < until && ended >= window.from;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Turn summaries of the agent between the run's start and end. */
export function runSummaries(task: QueueTask, summaries: readonly TurnSummary[], now: number): TurnSummary[] {
  if (!task.agentId || task.startedAt === null) return [];
  const until = (task.finishedAt ?? now) + 60_000;
  return summaries.filter((summary) => summary.agentId === task.agentId && summary.endedAt >= (task.startedAt as number) && summary.startedAt <= until);
}

/** The last result of each check command across the run's turns, ordered by when that result came. */
export function lastChecks(summaries: readonly TurnSummary[]): SummaryCheck[] {
  const byCommand = new Map<string, SummaryCheck>();
  for (const summary of [...summaries].sort((a, b) => a.endedAt - b.endedAt)) {
    for (const check of summary.checks) {
      byCommand.delete(check.command);
      byCommand.set(check.command, check);
    }
  }
  return [...byCommand.values()];
}

function changesFrom(review: InboxItem | undefined, summaries: readonly TurnSummary[]): ReportRun["changes"] {
  if (review) {
    return {
      source: "review",
      files: review.files.length,
      linesAdded: review.linesAdded,
      linesRemoved: review.linesRemoved,
      sample: review.files.slice(0, 3).map((file) => file.path),
    };
  }
  const tracked = summaries.filter((summary) => summary.filesTracked);
  if (tracked.length === 0) return null;
  const paths = new Set<string>();
  let more = 0;
  let added = 0;
  let removed = 0;
  for (const summary of tracked) {
    for (const file of summary.files) paths.add(file.path);
    more += summary.moreFiles;
    added += summary.totalAdded;
    removed += summary.totalRemoved;
  }
  return { source: "turns", files: paths.size + more, linesAdded: added, linesRemoved: removed, sample: [...paths].slice(0, 3) };
}

const NEED_ORDER: ReportNeed["kind"][] = ["permission", "question", "stuck", "overtime", "review", "retry"];

function needsFor(task: QueueTask, open: readonly NeedsItem[], review: InboxItem | undefined, checks: readonly SummaryCheck[]): ReportNeed[] {
  const needs: ReportNeed[] = [];
  for (const item of open) {
    if (item.kind === "permission") {
      const count = Math.max(1, item.requests.length);
      needs.push({ kind: "permission", label: count > 1 ? `Approve or deny ${count} requests: ${item.title}` : `Approve or deny: ${item.title}` });
    } else if (item.kind === "question") needs.push({ kind: "question", label: `Answer: ${item.title}` });
    else if (item.kind === "stuck") needs.push({ kind: "stuck", label: `Stuck: ${item.title}` });
    else needs.push({ kind: "overtime", label: `Over time: ${item.title}` });
  }
  if (review?.state === "open") {
    const failed = checks.filter((check) => !check.passed).length;
    const files = plural(review.files.length, "changed file");
    needs.push({ kind: "review", label: failed > 0 ? `Review ${files} (${plural(failed, "check")} failed)` : `Review ${files}` });
  } else if ((task.state === "failed" || task.state === "stopped") && open.length === 0) {
    needs.push({ kind: "retry", label: task.state === "failed" ? "Read the chat, then Retry or clear it" : "Read why it stopped, then Retry or clear it" });
  }
  return needs.sort((a, b) => NEED_ORDER.indexOf(a.kind) - NEED_ORDER.indexOf(b.kind));
}

export interface ReportInputs {
  now: number;
  hostLabel: string;
  start: string;
  end: string;
  tasks: readonly QueueTask[];
  inbox: readonly InboxItem[];
  /** Open Needs you items. */
  needs: readonly NeedsItem[];
  summaries: readonly TurnSummary[];
}

export function buildReport(input: ReportInputs): OvernightReport {
  const { now } = input;
  const window = overnightWindow(now, input.start, input.end);
  const runs: ReportRun[] = [];
  for (const task of input.tasks) {
    if (!ranInWindow(task, window, now)) continue;
    const review = input.inbox.find((item) => item.taskId === task.id || (task.agentId !== null && item.agentId === task.agentId));
    const summaries = runSummaries(task, input.summaries, now);
    const checks = lastChecks(summaries);
    const open = task.agentId ? input.needs.filter((item) => item.agentId === task.agentId && item.resolvedAt === null) : [];
    runs.push({
      taskId: task.id,
      title: task.title,
      projectName: task.projectName,
      state: task.state,
      startedBy: task.startedBy,
      startedAt: task.startedAt as number,
      finishedAt: task.finishedAt,
      outcome: task.outcome,
      agentId: task.agentId,
      changes: changesFrom(review, summaries),
      checks,
      review: review ? { itemId: review.id, state: review.state, prUrl: review.prUrl } : null,
      needs: needsFor(task, open, review, checks),
    });
  }
  runs.sort((a, b) => Number(b.needs.length > 0) - Number(a.needs.length > 0) || a.startedAt - b.startedAt);
  const count = (state: QueueTask["state"]) => runs.filter((run) => run.state === state).length;
  return {
    generatedAt: now,
    hostLabel: input.hostLabel,
    window: { start: input.start, end: input.end, ...window },
    counts: {
      runs: runs.length,
      finished: count("finished"),
      failed: count("failed"),
      stopped: count("stopped"),
      running: count("running") + count("starting"),
      review: runs.filter((run) => run.review?.state === "open").length,
      needsYou: runs.filter((run) => run.needs.length > 0).length,
      stillQueued: input.tasks.filter((task) => task.state === "queued").length,
    },
    runs,
  };
}
