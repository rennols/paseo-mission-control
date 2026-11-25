import { describe, expect, it } from "vitest";
import type { QueueTask } from "../shared/queue";
import { freeSlots, moveUp, nextTask, orderForDisplay, pruneHistory, shouldStopUnattended, slotHolders, titleFromPrompt, KEEP_HISTORY_MS } from "../server/queue/model";

const T0 = 1_700_000_000_000;

function task(id: string, partial: Partial<QueueTask> = {}): QueueTask {
  return {
    id,
    title: id,
    prompt: `do ${id}`,
    projectId: "prj",
    projectName: "repo",
    projectPath: "/repo",
    baseRef: null,
    profileKey: "provider:claude",
    profileLabel: "Claude defaults",
    state: "queued",
    createdAt: T0,
    attempt: 1,
    startedAt: null,
    finishedAt: null,
    startedBy: null,
    overLimit: false,
    agentId: null,
    workspaceId: null,
    lastChangeAt: null,
    outcome: null,
    ...partial,
  };
}

const agent = (id: string, status: "working" | "waiting" | "stuck" | "idle" | "error" | "closed", background = false) => ({ id, title: id, status, background });

describe("slots", () => {
  it("counts working, waiting and stuck agents, not idle, errored or background ones", () => {
    const holders = slotHolders([agent("a", "working"), agent("b", "waiting"), agent("c", "stuck"), agent("d", "idle"), agent("e", "error"), agent("f", "working", true)], []);
    expect(holders.map((holder) => holder.agentId)).toEqual(["a", "b", "c"]);
    expect(freeSlots(3, holders)).toBe(0);
    expect(freeSlots(5, holders)).toBe(2);
  });

  it("holds a slot for a task still being created, so a burst never overshoots the limit", () => {
    const holders = slotHolders([agent("a", "working")], [task("t1", { state: "starting" }), task("t2", { state: "running", agentId: "not-listed-yet" })]);
    expect(holders.map((holder) => holder.taskId)).toEqual([null, "t1", "t2"]);
    expect(freeSlots(3, holders)).toBe(0);
  });

  it("does not count a running task twice once its agent is listed", () => {
    const holders = slotHolders([agent("x", "working")], [task("t1", { state: "running", agentId: "x" })]);
    expect(holders).toHaveLength(1);
    expect(holders[0]?.taskId).toBe("t1");
  });

  it("frees the slot of a task the unattended rule stopped, even if its agent still waits", () => {
    const holders = slotHolders([agent("x", "waiting")], [task("t1", { state: "stopped", agentId: "x" })]);
    expect(holders).toHaveLength(0);
  });
});

describe("order", () => {
  it("starts the first queued task", () => {
    const tasks = [task("a", { state: "running" }), task("b"), task("c")];
    expect(nextTask(tasks)?.id).toBe("b");
    expect(nextTask([task("a", { state: "finished" })])).toBeUndefined();
  });

  it("moves a queued task above the previous queued task, skipping running ones", () => {
    const tasks = [task("a"), task("r", { state: "running" }), task("b")];
    expect(moveUp(tasks, "b")).toBe(true);
    expect(tasks.map((t) => t.id)).toEqual(["b", "r", "a"]);
    expect(moveUp(tasks, "b")).toBe(false);
  });

  it("lists queued, then live, then recent history newest first, and prunes old history", () => {
    const now = T0 + KEEP_HISTORY_MS + 10;
    const tasks = [
      task("old", { state: "finished", finishedAt: T0 }),
      task("done1", { state: "finished", finishedAt: now - 1000 }),
      task("q"),
      task("run", { state: "running" }),
      task("done2", { state: "failed", finishedAt: now - 10 }),
    ];
    expect(orderForDisplay(tasks, now).map((t) => t.id)).toEqual(["q", "run", "done2", "done1"]);
    expect(pruneHistory(tasks, now)).toBe(true);
    expect(tasks.map((t) => t.id)).toEqual(["done1", "q", "run", "done2"]);
  });
});

describe("unattended rule", () => {
  const minute = 60_000;
  it("stops a running task holding a slot with no file changes for the limit", () => {
    const running = task("t", { state: "running", startedAt: T0, lastChangeAt: T0 });
    expect(shouldStopUnattended(running, true, T0 + 59 * minute, 60)).toBe(false);
    expect(shouldStopUnattended(running, true, T0 + 60 * minute, 60)).toBe(true);
  });

  it("counts from the last file change", () => {
    const running = task("t", { state: "running", startedAt: T0, lastChangeAt: T0 + 30 * minute });
    expect(shouldStopUnattended(running, true, T0 + 70 * minute, 60)).toBe(false);
    expect(shouldStopUnattended(running, true, T0 + 90 * minute, 60)).toBe(true);
  });

  it("never stops an agent that holds no slot, or a task that is not running", () => {
    expect(shouldStopUnattended(task("t", { state: "running", startedAt: T0 }), false, T0 + 999 * minute, 60)).toBe(false);
    expect(shouldStopUnattended(task("t", { state: "finished", startedAt: T0 }), true, T0 + 999 * minute, 60)).toBe(false);
  });
});

describe("titles", () => {
  it("uses the prompt's first line, cut to 60 characters", () => {
    expect(titleFromPrompt("Fix the login bug\nmore detail")).toBe("Fix the login bug");
    expect(titleFromPrompt("x".repeat(80))).toHaveLength(60);
  });
});
