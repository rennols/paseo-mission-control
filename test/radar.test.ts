import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TurnSummary } from "../shared/chat";
import { takeSnapshot } from "../server/chat/snapshot";
import { rowBadges } from "../server/live/row-badges";
import { LOCAL, createRegistry } from "../server/live/registry";
import { createNeedsStore } from "../server/needs/needs";
import type { PaseoAdapter } from "../server/paseo/adapter";
import { classifyFile, describeCollision, overlaps, pairKey, parseHunks, reachesNewFile } from "../server/radar/model";
import { createRadar, type RadarMode } from "../server/radar/radar";
import type { PluginLogger } from "../server/log";
import { emptyState, type StateStore } from "../server/state/store";

const quiet: PluginLogger = { info() {}, warn() {}, error() {} };

describe("collision radar model", () => {
  it("parses -U0 hunk headers, including counts of 1 and pure insertions", () => {
    const diff = [
      "diff --git a/x b/x",
      "@@ -3 +3 @@ function parse(input) {",
      "-a",
      "+b",
      "@@ -10,0 +11,2 @@",
      "@@ -20,4 +22,0 @@ class Store",
    ].join("\n");
    expect(parseHunks(diff)).toEqual([
      { start: 3, count: 1, header: "function parse(input) {" },
      { start: 10, count: 0, header: null },
      { start: 20, count: 4, header: "class Store" },
    ]);
  });

  it("counts overlapping and adjacent changes, like git's merge", () => {
    const a = [{ start: 10, count: 3, header: "function f()" }]; // lines 10-12
    expect(overlaps(a, [{ start: 12, count: 1, header: null }])).toHaveLength(1); // overlap
    expect(overlaps(a, [{ start: 13, count: 1, header: null }])).toHaveLength(1); // adjacent
    expect(overlaps(a, [{ start: 15, count: 1, header: null }])).toHaveLength(0); // apart
    expect(overlaps(a, [{ start: 12, count: 0, header: null }])).toHaveLength(1); // insert after 12
    expect(overlaps(a, [{ start: 14, count: 0, header: null }])).toHaveLength(0); // insert after 14
    expect(overlaps(a, [{ start: 11, count: 1, header: null }])[0]).toEqual({ from: 10, to: 12, header: "function f()" });
  });

  it("skips files with the same result or where one side started from the other's result", () => {
    expect(classifyFile({ baseA: "1", headA: "2", baseB: "1", headB: "2" }).kind).toBe("skip");
    expect(classifyFile({ baseA: "1", headA: "2", baseB: "2", headB: "3" }).kind).toBe("skip");
    expect(classifyFile({ baseA: "1", headA: undefined, baseB: "1", headB: "3" })).toEqual({ kind: "structural", reason: "deleted on one side" });
    expect(classifyFile({ baseA: undefined, headA: "2", baseB: undefined, headB: "3" })).toEqual({ kind: "structural", reason: "both created" });
    expect(classifyFile({ baseA: "1", headA: "2", baseB: "1", headB: "3" }).kind).toBe("compare");
  });

  it("writes a short card with text, not just colour", () => {
    const text = describeCollision({ title: "refund-ui", branch: "feat/refund" }, [
      { path: "src/b.ts", level: "file", overlaps: [], reason: null },
      { path: "src/a.ts", level: "lines", overlaps: [{ from: 40, to: 52, header: "export function parse(input: string) {" }], reason: null },
    ]);
    expect(text.title).toBe("Same lines as refund-ui on feat/refund");
    expect(text.detail).toBe("src/a.ts lines 40–52 in export function parse(input: string)\nsrc/b.ts: same file, different lines");
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
    expect(reachesNewFile("a\nb", "a")).toBe(false);
    expect(reachesNewFile("a", "a\nc")).toBe(true);
  });

  it("badges both agents' workspace rows", () => {
    const badges = rowBadges(
      [{ agentId: "a1", kind: "collision", resolvedAt: null, relatedAgentIds: ["a2"] }],
      (id) => (id === "a1" ? "w1" : "w2"),
      45,
    );
    expect(badges.w1?.[0]?.label).toBe("overlap");
    expect(badges.w2?.[0]?.label).toBe("overlap");
  });
});

// --- Real git worktrees -------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

const FILE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function edit(root: string, file: string, change: (lines: string[]) => void): void {
  const lines = readFileSync(path.join(root, file), "utf8").split("\n");
  change(lines);
  writeFileSync(path.join(root, file), lines.join("\n"));
}

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "mc-radar-"));
  const main = path.join(base, "repo");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(path.join(main, "app.ts"), FILE);
  writeFileSync(path.join(main, "other.ts"), FILE);
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const wtA = path.join(base, "wt-a");
  const wtB = path.join(base, "wt-b");
  git(main, "worktree", "add", "-q", "-b", "a", wtA);
  git(main, "worktree", "add", "-q", "-b", "b", wtB);
  const scratch = path.join(base, "scratch");

  const state = emptyState();
  const store: StateStore = { state, changed() {}, flush: async () => {} };
  const needs = createNeedsStore(store);
  const registry = createRegistry({ hasOpen: () => false });
  for (const [id, cwd, branch] of [["agent-a", wtA, "a"], ["agent-b", wtB, "b"]] as const) {
    const entry = registry.upsertFromHook(LOCAL, { id, cwd, title: id, provider: "claude", workspaceId: `ws-${id}` } as never);
    entry.branch = branch;
  }
  const hooks = new Map<string, (payload: unknown) => Promise<void>>();
  const adapter = {
    addHook: (name: string, _feature: string, handler: (payload: unknown) => Promise<void>) => {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
  } as unknown as PaseoAdapter;
  let mode: RadarMode = "lines";
  const radar = createRadar(adapter, registry, needs, store, () => mode, quiet);

  let turn = 0;
  async function runTurn(agentId: string, root: string, work: () => void): Promise<void> {
    const before = await takeSnapshot(root, scratch);
    work();
    const after = await takeSnapshot(root, scratch);
    turn += 1;
    const summary = {
      agentId,
      turnId: `t${turn}`,
      trees: before && after ? { before: before.tree, after: after.tree } : null,
    } as TurnSummary;
    radar.noteTurn(summary, after?.root ?? null);
    await radar.idle();
  }
  const open = () => needs.list().filter((item) => item.kind === "collision" && item.resolvedAt === null);
  return { base, wtA, wtB, needs, radar, hooks, runTurn, open, setMode: (next: RadarMode) => (mode = next), state };
}

describe("collision radar on real worktrees", () => {
  it("flags the same lines, ignores different lines, and closes when the overlap goes", async () => {
    const t = setup();
    try {
      await t.runTurn("agent-a", t.wtA, () => edit(t.wtA, "app.ts", (l) => (l[9] = "A changed line 10")));
      expect(t.open()).toHaveLength(0);

      // B edits a far-away part of the same file: no card in "lines" mode.
      await t.runTurn("agent-b", t.wtB, () => edit(t.wtB, "app.ts", (l) => (l[30] = "B changed line 31")));
      expect(t.open()).toHaveLength(0);

      // B now edits the line next to A's: git would conflict.
      await t.runTurn("agent-b", t.wtB, () => edit(t.wtB, "app.ts", (l) => (l[10] = "B changed line 11")));
      const [card] = t.open();
      expect(card).toMatchObject({ agentId: "agent-b", relatedAgentIds: ["agent-a"], title: "Same lines as agent-a on a" });
      expect(card?.detail).toContain("app.ts lines 10–11");

      // B reverts line 11: the overlap is gone and the card closes on its own.
      await t.runTurn("agent-b", t.wtB, () => edit(t.wtB, "app.ts", (l) => (l[10] = "line 11")));
      expect(t.open()).toHaveLength(0);
      expect(t.needs.list().find((item) => item.kind === "collision")?.resolution).toBe("No longer overlapping agent-a.");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  it("flags any shared file in Same file mode, and stays quiet after Dismiss until a new file overlaps", async () => {
    const t = setup();
    try {
      t.setMode("files");
      await t.runTurn("agent-a", t.wtA, () => edit(t.wtA, "app.ts", (l) => (l[1] = "A")));
      await t.runTurn("agent-b", t.wtB, () => edit(t.wtB, "app.ts", (l) => (l[35] = "B")));
      const [card] = t.open();
      expect(card?.title).toBe("Same file as agent-a on a");
      expect(card?.detail).toBe("app.ts: same file, different lines");

      t.radar.dismissed(card!.key!);
      t.needs.resolve(card!.id, "Dismissed.");
      await t.runTurn("agent-a", t.wtA, () => edit(t.wtA, "app.ts", (l) => (l[2] = "A again")));
      expect(t.open()).toHaveLength(0);

      await t.runTurn("agent-a", t.wtA, () => edit(t.wtA, "other.ts", (l) => (l[0] = "A")));
      await t.runTurn("agent-b", t.wtB, () => edit(t.wtB, "other.ts", (l) => (l[0] = "B")));
      expect(t.open()).toHaveLength(1);
      expect(t.open()[0]?.title).toBe("Same lines as agent-a on a");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  it("does not flag when both made the same change, and closes cards when an agent is archived", async () => {
    const t = setup();
    try {
      await t.runTurn("agent-a", t.wtA, () => edit(t.wtA, "app.ts", (l) => (l[4] = "same fix")));
      await t.runTurn("agent-b", t.wtB, () => edit(t.wtB, "app.ts", (l) => (l[4] = "same fix")));
      expect(t.open()).toHaveLength(0);

      await t.runTurn("agent-b", t.wtB, () => edit(t.wtB, "app.ts", (l) => (l[5] = "B only")));
      expect(t.open()).toHaveLength(1);

      await t.hooks.get("agent.archive.after")!({ agent: { id: "agent-a", title: "agent-a" } });
      expect(t.open()).toHaveLength(0);
      expect(t.state.radar.agents["agent-a"]).toBeUndefined();
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });
});
