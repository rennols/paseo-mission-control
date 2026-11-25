import { describe, expect, it } from "vitest";
import type { TurnSummary } from "../shared/chat";
import type { NeedsItem } from "../shared/live";
import type { InboxItem, QueueTask } from "../shared/queue";
import { buildReport, lastChecks, overnightWindow, ranInWindow } from "../server/report/model";
import { queueSettings } from "../shared/settings";

/** Local time, like the daemon. */
const local = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();
const MIN = 60_000;

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
    state: "finished",
    createdAt: local(24, 21),
    attempt: 1,
    startedAt: null,
    finishedAt: null,
    startedBy: "queue",
    overLimit: false,
    agentId: `agent-${id}`,
    workspaceId: null,
    lastChangeAt: null,
    outcome: null,
    ...partial,
  };
}

function summary(agentId: string, startedAt: number, partial: Partial<TurnSummary> = {}): TurnSummary {
  return {
    agentId,
    turnId: `turn-${agentId}-${startedAt}`,
    startedAt,
    endedAt: startedAt + 10 * MIN,
    outcome: "completed",
    filesTracked: true,
    files: [],
    moreFiles: 0,
    totalAdded: 0,
    totalRemoved: 0,
    checks: [],
    question: null,
    trees: null,
    ...partial,
  };
}

function inboxItem(agentId: string, taskId: string, partial: Partial<InboxItem> = {}): InboxItem {
  return {
    id: agentId,
    agentId,
    title: "t",
    provider: "claude",
    workspaceName: "repo",
    branch: "feature",
    baseBranch: "main",
    cwd: "/wt",
    finishedAt: local(25, 1),
    taskId,
    summary: null,
    failedChecks: [],
    files: [
      { path: "a.ts", added: 10, removed: 1, untracked: false },
      { path: "b.ts", added: 5, removed: 0, untracked: true },
    ],
    linesAdded: 15,
    linesRemoved: 1,
    uncommitted: true,
    commitsAhead: 0,
    diffExcerpt: "",
    diffTruncated: false,
    state: "open",
    prUrl: null,
    resolvedAt: null,
    resolution: null,
    ...partial,
  };
}

function need(agentId: string, kind: NeedsItem["kind"], title: string): NeedsItem {
  return {
    id: `${agentId}:${kind}`,
    agentId,
    agentTitle: agentId,
    kind,
    title,
    detail: null,
    requests: kind === "permission" ? [{ requestId: "r1", title, detail: null }] : [],
    options: [],
    questionSource: null,
    openedAt: local(25, 2),
    resolvedAt: null,
    resolution: null,
  };
}

describe("overnight window", () => {
  it("in the morning, is last night's window from 22:00 to 07:00", () => {
    const window = overnightWindow(local(25, 9), "22:00", "07:00");
    expect(window).toEqual({ from: local(24, 22), to: local(25, 7), inProgress: false });
  });

  it("before midnight, is tonight's window so far", () => {
    expect(overnightWindow(local(25, 23, 30), "22:00", "07:00")).toEqual({ from: local(25, 22), to: local(26, 7), inProgress: true });
  });

  it("after midnight, is still the window that started yesterday", () => {
    expect(overnightWindow(local(26, 3), "22:00", "07:00")).toEqual({ from: local(25, 22), to: local(26, 7), inProgress: true });
  });

  it("in the evening before the start, is last night's", () => {
    expect(overnightWindow(local(25, 21, 59), "22:00", "07:00").from).toBe(local(24, 22));
  });

  it("handles a window inside one day", () => {
    expect(overnightWindow(local(25, 9), "01:00", "06:00")).toEqual({ from: local(25, 1), to: local(25, 6), inProgress: false });
    expect(overnightWindow(local(25, 0, 30), "01:00", "06:00").from).toBe(local(24, 1));
  });

  it("treats equal start and end as a whole day", () => {
    const window = overnightWindow(local(25, 9), "08:00", "08:00");
    expect(window.from).toBe(local(25, 8));
    expect(window.to).toBe(local(26, 8));
  });

  it("settings default to 22:00 to 07:00, and old documents without the window still parse", () => {
    const parsed = queueSettings.schema.parse({ slotLimit: 2, unattendedStopMinutes: 60 });
    expect(parsed.overnightStart).toBe("22:00");
    expect(parsed.overnightEnd).toBe("07:00");
    expect(queueSettings.schema.safeParse({ overnightStart: "25:00" }).success).toBe(false);
  });
});

describe("runs in the window", () => {
  const window = overnightWindow(local(25, 9), "22:00", "07:00");
  const now = local(25, 9);

  it("includes runs that started, ended or were running inside it", () => {
    expect(ranInWindow(task("in", { startedAt: local(24, 23), finishedAt: local(25, 0) }), window, now)).toBe(true);
    expect(ranInWindow(task("across-start", { startedAt: local(24, 21, 30), finishedAt: local(24, 22, 30) }), window, now)).toBe(true);
    expect(ranInWindow(task("still", { state: "running", startedAt: local(25, 6) }), window, now)).toBe(true);
  });

  it("leaves out runs before or after it, and tasks that never started", () => {
    expect(ranInWindow(task("before", { startedAt: local(24, 20), finishedAt: local(24, 21) }), window, now)).toBe(false);
    expect(ranInWindow(task("after", { startedAt: local(25, 8), finishedAt: local(25, 8, 30) }), window, now)).toBe(false);
    expect(ranInWindow(task("queued", { state: "queued", startedAt: null }), window, now)).toBe(false);
  });
});

describe("report", () => {
  const now = local(25, 8);
  const base = { now, hostLabel: "Neuro", start: "22:00", end: "07:00" };

  it("counts outcomes, review items and what needs you, needs-you runs first", () => {
    const tasks = [
      task("clean", { startedAt: local(24, 22, 5), finishedAt: local(24, 22, 40), outcome: "Finished after 35 min" }),
      task("review", { startedAt: local(24, 22, 6), finishedAt: local(24, 23, 30), outcome: "Finished after 84 min" }),
      task("stalled", { state: "stopped", startedAt: local(24, 23, 31), finishedAt: local(25, 0, 31), outcome: "Stopped by the watchdog after 60 min with no file changes" }),
      task("broke", { state: "failed", startedAt: local(25, 1), finishedAt: local(25, 1, 2), outcome: "Failed after 2 min: rate limited" }),
      task("asks", { state: "running", startedAt: local(25, 2) }),
      task("later", { state: "queued" }),
    ];
    const report = buildReport({
      ...base,
      tasks,
      inbox: [inboxItem("agent-review", "review")],
      needs: [need("agent-asks", "permission", "Bash: rm -rf build")],
      summaries: [summary("agent-review", local(24, 22, 6), { checks: [{ command: "npm test", passed: false, line: "1 failed" }] })],
    });
    expect(report.window.inProgress).toBe(false);
    expect(report.counts).toEqual({ runs: 5, finished: 2, failed: 1, stopped: 1, running: 1, review: 1, needsYou: 4, stillQueued: 1 });
    expect(report.runs.map((run) => run.taskId)).toEqual(["review", "stalled", "broke", "asks", "clean"]);
    const byId = Object.fromEntries(report.runs.map((run) => [run.taskId, run]));
    expect(byId.review?.needs).toEqual([{ kind: "review", label: "Review 2 changed files (1 check failed)" }]);
    expect(byId.review?.changes).toEqual({ source: "review", files: 2, linesAdded: 15, linesRemoved: 1, sample: ["a.ts", "b.ts"] });
    expect(byId.review?.review).toEqual({ itemId: "agent-review", state: "open", prUrl: null });
    expect(byId.stalled?.needs[0]?.kind).toBe("retry");
    expect(byId.stalled?.outcome).toContain("60 min with no file changes");
    expect(byId.asks?.needs).toEqual([{ kind: "permission", label: "Approve or deny: Bash: rm -rf build" }]);
    expect(byId.clean?.needs).toEqual([]);
  });

  it("without a review item, reads changes and checks from the run's turn summaries", () => {
    const t = task("t", { startedAt: local(24, 23), finishedAt: local(25, 0) });
    const report = buildReport({
      ...base,
      tasks: [t],
      inbox: [],
      needs: [],
      summaries: [
        summary("agent-t", local(24, 23), {
          files: [{ path: "x.ts", added: 3, removed: 1, status: "modified" }],
          totalAdded: 3,
          totalRemoved: 1,
          checks: [{ command: "npm test", passed: false, line: "boom" }],
        }),
        summary("agent-t", local(24, 23, 20), {
          files: [
            { path: "x.ts", added: 1, removed: 0, status: "modified" },
            { path: "y.ts", added: 4, removed: 0, status: "added" },
          ],
          totalAdded: 5,
          totalRemoved: 0,
          checks: [{ command: "npm test", passed: true, line: "12 passed" }],
        }),
        // Another agent, and the same agent's turn from an earlier run: both left out.
        summary("agent-other", local(24, 23)),
        summary("agent-t", local(24, 12), { files: [{ path: "old.ts", added: 1, removed: 0, status: "added" }], totalAdded: 1 }),
      ],
    });
    const run = report.runs[0];
    expect(run?.changes).toEqual({ source: "turns", files: 2, linesAdded: 8, linesRemoved: 1, sample: ["x.ts", "y.ts"] });
    expect(run?.checks).toEqual([{ command: "npm test", passed: true, line: "12 passed" }]);
    expect(run?.needs).toEqual([]);
  });

  it("shows an opened PR without asking for anything", () => {
    const t = task("pr", { startedAt: local(24, 23), finishedAt: local(25, 0) });
    const report = buildReport({ ...base, tasks: [t], inbox: [inboxItem("agent-pr", "pr", { state: "pr_opened", prUrl: "https://github.com/o/r/pull/1", resolvedAt: local(25, 7, 30) })], needs: [], summaries: [] });
    expect(report.runs[0]?.review).toEqual({ itemId: "agent-pr", state: "pr_opened", prUrl: "https://github.com/o/r/pull/1" });
    expect(report.runs[0]?.needs).toEqual([]);
    expect(report.counts.review).toBe(0);
  });

  it("is empty with no runs in the window", () => {
    const report = buildReport({ ...base, tasks: [task("q", { state: "queued" })], inbox: [], needs: [], summaries: [] });
    expect(report.counts.runs).toBe(0);
    expect(report.counts.stillQueued).toBe(1);
    expect(report.runs).toEqual([]);
  });

  it("keeps the last result of each check, ordered by when it came", () => {
    const checks = lastChecks([
      summary("a", 2, { checks: [{ command: "lint", passed: true, line: null }] }),
      summary("a", 1, { checks: [{ command: "test", passed: false, line: "x" }, { command: "lint", passed: false, line: "y" }] }),
    ]);
    expect(checks).toEqual([
      { command: "test", passed: false, line: "x" },
      { command: "lint", passed: true, line: null },
    ]);
  });
});
