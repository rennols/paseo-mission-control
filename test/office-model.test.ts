import { describe, expect, it } from "vitest";
import { HELPER_KEEP_MS, MAX_HELPERS, applyItem, describeNow, emptyActivity, endTurn, helpersOf } from "../server/office/model";
import { buildRooms, deskTime, isQuiet, officeCounts, roomMeta } from "../client/office-format";
import type { AgentRow } from "../shared/live";

const call = (callId: string, status: string, detail: Record<string, unknown>, name = "tool") => ({
  type: "tool_call",
  callId,
  name,
  status,
  error: null,
  detail,
});

const task = (callId: string, status: string, extra: Record<string, unknown> = {}) =>
  call(callId, status, { type: "sub_agent", subAgentType: "Explore", description: "Find every caller of startTask", ...extra }, "Task");

describe("describeNow", () => {
  it("names the tool call in words", () => {
    expect(describeNow(call("1", "running", { type: "shell", command: "npm test" }))).toEqual({ text: "Running npm test", kind: "run" });
    expect(describeNow(call("1", "completed", { type: "shell", command: "npm test" }))?.text).toBe("Ran npm test");
    expect(describeNow(call("2", "running", { type: "edit", filePath: "/repo/server/queue/dispatch.ts" }))).toEqual({ text: "Editing dispatch.ts", kind: "edit" });
    expect(describeNow(call("3", "running", { type: "read", filePath: "C:\\repo\\README.md" }))?.text).toBe("Reading README.md");
    expect(describeNow(call("4", "running", { type: "search", query: "startTask" }))?.kind).toBe("search");
    expect(describeNow(call("5", "running", { type: "fetch", url: "https://paseo.sh/llms.txt" }))?.text).toBe("Fetching paseo.sh/llms.txt");
    expect(describeNow({ type: "reasoning", text: "hmm" })).toEqual({ text: "Thinking", kind: "think" });
    expect(describeNow({ type: "user_message", text: "hi" })).toBeNull();
  });

  it("shows a handoff for a sub_agent call", () => {
    expect(describeNow(task("t1", "running"))).toEqual({ text: "Handed off: Find every caller of startTask", kind: "delegate" });
  });
});

describe("applyItem", () => {
  it("tracks a helper from start to finish with its latest action", () => {
    const activity = emptyActivity();
    expect(applyItem(activity, task("t1", "running"), 1000)).toBe(true);
    expect(activity.now).toBe("Handed off: Find every caller of startTask");
    applyItem(activity, task("t1", "running", { actions: [{ index: 0, toolName: "Grep", summary: "startTask" }, { index: 1, toolName: "Read", summary: "/repo/server/queue/queue.ts" }] }), 2000);
    let [helper] = helpersOf(activity, 2000);
    expect(helper).toMatchObject({ id: "t1", type: "Explore", ask: "Find every caller of startTask", status: "working", lastAction: "Read queue.ts", startedAt: 1000, endedAt: null });

    // The parent moves on; the helper's later updates don't take over its now line.
    applyItem(activity, call("e1", "running", { type: "edit", filePath: "/repo/a.ts" }), 3000);
    applyItem(activity, task("t1", "completed"), 4000);
    expect(activity.now).toBe("Editing a.ts");
    [helper] = helpersOf(activity, 4000);
    expect(helper).toMatchObject({ status: "done", endedAt: 4000, lastAction: "Read queue.ts" });
  });

  it("reads a bare Task call with the provider's activity note", () => {
    const activity = emptyActivity();
    applyItem(activity, { ...call("t2", "running", { type: "unknown" }, "Task"), metadata: { subAgentActivity: "Reading files" } }, 10);
    expect(helpersOf(activity, 10)[0]).toMatchObject({ type: "Task", lastAction: "Reading files", status: "working" });
  });

  it("reports no change for a repeat", () => {
    const activity = emptyActivity();
    applyItem(activity, call("1", "running", { type: "shell", command: "ls" }), 1);
    expect(applyItem(activity, call("1", "running", { type: "shell", command: "ls" }), 2)).toBe(false);
  });

  it("lets finished helpers leave after the keep time, and caps the desk count", () => {
    const activity = emptyActivity();
    applyItem(activity, task("old", "completed"), 0);
    expect(helpersOf(activity, HELPER_KEEP_MS)).toHaveLength(1);
    expect(helpersOf(activity, HELPER_KEEP_MS + 1)).toHaveLength(0);

    for (let i = 0; i < MAX_HELPERS + 3; i += 1) applyItem(activity, task(`h${i}`, i < 5 ? "completed" : "running"), 100 + i);
    const helpers = helpersOf(activity, 200);
    expect(helpers).toHaveLength(MAX_HELPERS);
    expect(helpers.filter((h) => h.status === "working")).toHaveLength(MAX_HELPERS + 3 - 5);
    expect(helpers[0]?.id).toBe(`h${MAX_HELPERS + 2}`);
  });
});

describe("endTurn", () => {
  it("clears the now line and closes helpers left running", () => {
    const activity = emptyActivity();
    applyItem(activity, task("t1", "running"), 1);
    expect(endTurn(activity, 5, "canceled")).toBe(true);
    expect(activity.now).toBeNull();
    expect(helpersOf(activity, 5)[0]).toMatchObject({ status: "stopped", endedAt: 5 });
  });
});

describe("buildRooms", () => {
  const row = (id: string, status: AgentRow["status"], extra: Partial<AgentRow> = {}): AgentRow => ({
    id,
    serverId: "s1",
    hostLabel: "neuro",
    title: id,
    provider: "claude",
    workspaceKey: "local:/repo",
    workspaceName: "repo",
    branch: "main",
    parentAgentId: null,
    status,
    since: 0,
    linesAdded: null,
    linesRemoved: null,
    latestActivity: null,
    now: null,
    nowKind: null,
    helpers: [],
    lane: [],
    marks: [],
    laneDescription: "",
    watched: true,
    ...extra,
  });

  it("puts Paseo subagents and in-agent helpers at desks in their supervisor's room", () => {
    const helper = { id: "t1", type: "Explore", ask: "Find callers", status: "working" as const, lastAction: null, startedAt: 5, endedAt: null };
    const rooms = buildRooms([
      row("boss", "working", { helpers: [helper] }),
      row("worker", "waiting", { parentAgentId: "boss" }),
      row("grandchild", "working", { parentAgentId: "worker" }),
      row("solo", "idle"),
      row("gone", "closed"),
    ], false);
    expect(rooms.map((room) => room.supervisor.id)).toEqual(["boss", "solo"]);
    const [boss] = rooms;
    expect(boss?.desks.map((desk) => desk.key)).toEqual(["s1:worker", "s1:grandchild", "helper:s1:boss:t1"]);
    expect(boss?.desks[1]).toMatchObject({ reportsTo: "worker" });
    expect(boss?.desks[2]).toMatchObject({ kind: "in-agent", state: "working" });
  });

  it("shows a finished Paseo subagent as done, and closed rooms only when asked", () => {
    const rooms = buildRooms([
      row("boss", "idle"),
      row("worker", "idle", { parentAgentId: "boss", marks: [{ kind: "finished", at: 1 }] }),
      row("gone", "closed"),
    ], true);
    expect(rooms.find((room) => room.supervisor.id === "boss")?.desks[0]?.state).toBe("done");
    expect(rooms.map((room) => room.supervisor.id)).toContain("gone");
  });

  it("folds quiet rooms, counts everyone and words the desk times", () => {
    const rooms = buildRooms([
      row("busy", "working", { since: 0 }),
      row("worker", "waiting", { parentAgentId: "busy", since: 60_000 }),
      row("quiet", "idle", { since: 0 }),
      row("old", "idle", { parentAgentId: "quiet", marks: [{ kind: "finished", at: 0 }] }),
      row("fresh", "idle", { since: 0 }),
      row("recent", "idle", { parentAgentId: "fresh", marks: [{ kind: "finished", at: 20 * 60_000 }] }),
    ], false);
    const now = 21 * 60_000;
    const byId = (id: string) => rooms.find((room) => room.supervisor.id === id)!;
    expect(isQuiet(byId("busy"), now)).toBe(false);
    expect(isQuiet(byId("quiet"), now)).toBe(true); // its engineer finished 21 min ago
    expect(isQuiet(byId("fresh"), now)).toBe(false); // finished 1 min ago: still on show
    expect(officeCounts(rooms)).toEqual({ working: 1, waiting: 1, stuck: 0, done: 2 });
    expect(rooms[0]?.supervisor.id).toBe("busy");
    expect(deskTime(byId("busy").desks[0]!, now)).toBe("for 20m");
    expect(deskTime(byId("fresh").desks[0]!, now)).toBe("1m ago");
  });

  it("puts desks that need you first", () => {
    const [room] = buildRooms([
      row("boss", "working"),
      row("a", "working", { parentAgentId: "boss", since: 1 }),
      row("b", "stuck", { parentAgentId: "boss", since: 2 }),
    ], false);
    expect(room?.desks.map((desk) => desk.title)).toEqual(["b", "a"]);
  });

  it("drops the branch from the room subtitle when it repeats the room name", () => {
    expect(roomMeta(row("x", "idle", { workspaceName: "master", branch: "master" }))).toBe("neuro");
    expect(roomMeta(row("x", "idle", { workspaceName: "repo", branch: "feat/q", watched: false }))).toBe("neuro · feat/q · read only");
  });
});
