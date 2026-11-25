import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLane, describeLane, recordTransition } from "../server/live/lanes";
import { createNeedsStore } from "../server/needs/needs";
import { emptyState, openStateStore, type StateStore } from "../server/state/store";
import type { PluginLogger } from "../server/log";

const quiet: PluginLogger = { info() {}, warn() {}, error() {} };

function memoryStore(): StateStore {
  const state = emptyState();
  return { state, changed() {}, flush: async () => {} };
}

describe("Needs you", () => {
  it("groups permission requests per agent and closes the card when the last is answered", () => {
    let now = 1_000;
    const needs = createNeedsStore(memoryStore(), () => now);
    needs.addPermission("a1", "refund-ui", { requestId: "r1", title: "Use list_providers", detail: null });
    needs.addPermission("a1", "refund-ui", { requestId: "r2", title: "Use create_agent", detail: null });
    expect(needs.openCount()).toBe(1);
    expect(needs.list()[0]?.requests.map((r) => r.requestId)).toEqual(["r1", "r2"]);

    needs.closePermission("a1", "r1", "Allowed.");
    expect(needs.openCount()).toBe(1);
    now = 2_000;
    needs.closePermission("a1", "r2", "Allowed. refund-ui is working again.");
    expect(needs.openCount()).toBe(0);
    expect(needs.list()[0]).toMatchObject({ resolvedAt: 2_000, resolution: "Allowed. refund-ui is working again." });
  });

  it("orders open items by urgency and keeps one Stuck card per agent", () => {
    const needs = createNeedsStore(memoryStore(), () => 5);
    needs.raise("a1", "one", "stuck", "Same error 3 turns in a row", "npm test: fail");
    needs.raise("a1", "one", "stuck", "Same error 4 turns in a row", "npm test: fail");
    needs.raise("a2", "two", "overtime", "Running for 50 min", null);
    needs.addPermission("a3", "three", { requestId: "r", title: "Run rm", detail: null });
    expect(needs.list().map((item) => item.kind)).toEqual(["permission", "stuck", "overtime"]);
    expect(needs.openFor("a1", "stuck")[0]?.title).toBe("Same error 4 turns in a row");
  });

  it("closes a tool question when its request resolves", () => {
    const needs = createNeedsStore(memoryStore(), () => 1);
    needs.openQuestion("a1", "one", "tool", "src or docs?", [{ label: "src" }, { label: "docs" }], "q1");
    needs.closePermission("a1", "q1", "Dismissed.");
    expect(needs.openCount()).toBe(0);
  });

  it("persists through the state file with a temp file and rename", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-state-"));
    const store = openStateStore(directory, quiet);
    createNeedsStore(store).raise("a1", "one", "stuck", "No file changes for 5 turns", null);
    await store.flush();
    const saved = JSON.parse(readFileSync(path.join(directory, "state.json"), "utf8"));
    expect(saved.needs).toHaveLength(1);
    expect(openStateStore(directory, quiet).state.needs[0]?.title).toBe("No file changes for 5 turns");
  });
});

describe("lanes", () => {
  it("cuts the last 30 minutes and merges repeats of one kind", () => {
    const min = 60_000;
    let transitions = recordTransition([], "idle", 0);
    transitions = recordTransition(transitions, "working", 10 * min);
    transitions = recordTransition(transitions, "working", 12 * min);
    transitions = recordTransition(transitions, "stuck", 40 * min);
    const lane = buildLane(transitions, 45 * min);
    expect(lane).toEqual([
      { kind: "working", from: 15 * min, to: 40 * min },
      { kind: "stuck", from: 40 * min, to: 45 * min },
    ]);
    expect(describeLane(lane, [{ kind: "repeat", at: 44 * min }])).toBe("Last 30 min: working 25 min, stuck 5 min. 1 repeated error.");
  });
});
