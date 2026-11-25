/**
 * Pure queue rules: who holds a slot, which task starts next, ordering and the unattended stop.
 * No Paseo, git or timers here, so every rule is unit tested (test/queue-model.test.ts).
 */
import type { AgentStatus } from "../../shared/live";
import type { QueueTask, SlotHolder } from "../../shared/queue";

/** PRD: an agent that is working, waiting, stuck or paused keeps its slot. Paused is not in v1. */
export const SLOT_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["working", "waiting", "stuck"]);

/** Finished, failed and stopped runs stay listed this long (the overnight report reads them). */
export const KEEP_HISTORY_MS = 24 * 60 * 60_000;

export interface SlotAgent {
  id: string;
  title: string;
  status: AgentStatus;
  background: boolean;
}

/**
 * Agents holding a slot on this host, plus tasks still being created (their agent isn't listed
 * yet). Agents of tasks the unattended rule stopped never hold a slot, even if Paseo still shows
 * them waiting: that is what "stopped to free its slot" means.
 */
export function slotHolders(agents: readonly SlotAgent[], tasks: readonly QueueTask[]): SlotHolder[] {
  const taskByAgent = new Map(tasks.filter((task) => task.agentId).map((task) => [task.agentId as string, task]));
  const holders: SlotHolder[] = [];
  const listed = new Set<string>();
  for (const agent of agents) {
    if (agent.background || !SLOT_STATUSES.has(agent.status)) continue;
    const task = taskByAgent.get(agent.id);
    if (task?.state === "stopped") continue;
    holders.push({ agentId: agent.id, title: agent.title, status: agent.status, taskId: task?.id ?? null });
    listed.add(agent.id);
  }
  for (const task of tasks) {
    const pending = task.state === "starting" || (task.state === "running" && task.agentId && !agents.some((agent) => agent.id === task.agentId));
    if (!pending || (task.agentId && listed.has(task.agentId))) continue;
    holders.push({ agentId: task.agentId ?? `task:${task.id}`, title: task.title, status: "working", taskId: task.id });
  }
  return holders;
}

export function freeSlots(limit: number, holders: readonly SlotHolder[]): number {
  return Math.max(0, limit - holders.length);
}

/** The first queued task, in queue order. Start conditions other than "next free slot" are P2. */
export function nextTask(tasks: readonly QueueTask[]): QueueTask | undefined {
  return tasks.find((task) => task.state === "queued");
}

/** Swaps a queued task with the queued task before it. Returns false when it is already first. */
export function moveUp(tasks: QueueTask[], taskId: string): boolean {
  const index = tasks.findIndex((task) => task.id === taskId && task.state === "queued");
  if (index < 0) return false;
  for (let previous = index - 1; previous >= 0; previous--) {
    if (tasks[previous]?.state !== "queued") continue;
    const moving = tasks[index] as QueueTask;
    tasks[index] = tasks[previous] as QueueTask;
    tasks[previous] = moving;
    return true;
  }
  return false;
}

/** Queued tasks first in order, then live runs, then recent history (newest first). */
export function orderForDisplay(tasks: readonly QueueTask[], now: number): QueueTask[] {
  const queued = tasks.filter((task) => task.state === "queued");
  const live = tasks.filter((task) => task.state === "starting" || task.state === "running");
  const done = tasks
    .filter((task) => task.state === "finished" || task.state === "failed" || task.state === "stopped")
    .filter((task) => now - (task.finishedAt ?? task.createdAt) < KEEP_HISTORY_MS)
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
  return [...queued, ...live, ...done];
}

/** Drops history older than KEEP_HISTORY_MS. Returns true when anything was dropped. */
export function pruneHistory(tasks: QueueTask[], now: number): boolean {
  const before = tasks.length;
  const kept = tasks.filter(
    (task) =>
      !(task.state === "finished" || task.state === "failed" || task.state === "stopped") ||
      now - (task.finishedAt ?? task.createdAt) < KEEP_HISTORY_MS,
  );
  if (kept.length === before) return false;
  tasks.splice(0, tasks.length, ...kept);
  return true;
}

/**
 * Unattended rule (PRD): a queue-started agent that changes no files for `stopMinutes` while it
 * holds a slot is stopped to free that slot. `lastChangeAt` starts at the run's start.
 */
export function shouldStopUnattended(task: QueueTask, holdsSlot: boolean, now: number, stopMinutes: number): boolean {
  if (task.state !== "running" || !holdsSlot) return false;
  const since = task.lastChangeAt ?? task.startedAt;
  if (since === null) return false;
  return now - since >= stopMinutes * 60_000;
}

/** A short title from the prompt's first line when the user gives none. */
export function titleFromPrompt(prompt: string): string {
  const first = prompt.trim().split("\n")[0]?.trim() ?? "Task";
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first || "Task";
}

export function idempotencyKey(task: QueueTask): string {
  return `mission-control:${task.id}:${task.attempt}`;
}

export function minutesBetween(from: number | null, to: number): number | null {
  return from === null ? null : Math.max(0, Math.round((to - from) / 60_000));
}
