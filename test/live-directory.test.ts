import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeed } from "../server/live/feed";
import type { HostsService } from "../server/live/hosts";
import { LOCAL, createRegistry, lifecycleOf } from "../server/live/registry";
import type { PluginLogger } from "../server/log";
import type { NeedsStore } from "../server/needs/needs";

const noNeeds = { hasOpen: () => false };
const quietLog: PluginLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as PluginLogger;

function agent(id: string, status: string, activeTurn: { turnId: string; startedAt: string } | null = null) {
  return {
    id,
    title: id,
    provider: "claude/opus",
    cwd: "/w",
    status,
    activeTurn,
    createdAt: "2026-11-25T09:00:00.000Z",
    labels: {},
    pendingPermissions: [],
    background: false,
    archivedAt: null,
  } as never;
}

describe("agents already running when Mission Control starts", () => {
  it("counts an agent with an active turn as working, whatever its status says", () => {
    const turn = { turnId: "t1", startedAt: "2026-11-25T09:10:00.000Z" };
    expect(lifecycleOf({ status: "running", activeTurn: turn } as never)).toBe("running");
    expect(lifecycleOf({ status: "idle", activeTurn: turn } as never)).toBe("running");
    expect(lifecycleOf({ status: "initializing", activeTurn: turn } as never)).toBe("running");
    expect(lifecycleOf({ status: "idle", activeTurn: null } as never)).toBe("idle");
    expect(lifecycleOf({ status: "error", activeTurn: turn } as never)).toBe("error");
  });

  it("shows the directory's running agents as working on the first read", () => {
    const registry = createRegistry(noNeeds, () => Date.parse("2026-11-25T09:15:00.000Z"));
    const turn = (id: string) => ({ turnId: id, startedAt: "2026-11-25T09:10:00.000Z" });
    registry.replaceHost(LOCAL, [
      { agent: agent("a", "running", turn("1")), project: null },
      { agent: agent("b", "running", turn("2")), project: null },
      { agent: agent("c", "idle", turn("3")), project: null },
      { agent: agent("d", "idle"), project: null },
    ]);
    const rows = registry.rows(new Map([[LOCAL, "Neuro"]]), () => "srv");
    expect(rows.filter((row) => row.status === "working").map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
    expect(rows.find((row) => row.id === "a")?.since).toBe(Date.parse("2026-11-25T09:10:00.000Z"));
  });
});

describe("first Live snapshot", () => {
  afterEach(() => vi.useRealTimers());

  function setup(ready: boolean) {
    const registry = createRegistry(noNeeds);
    const needs = { list: () => [], openCount: () => 0, onChange: () => () => undefined } as unknown as NeedsStore;
    let loaded = ready;
    const listeners = new Set<() => void>();
    const hosts = {
      self: () => ({ serverId: "srv", label: "Neuro" }),
      summaries: () => [],
      labels: () => new Map([[LOCAL, "Neuro"]]),
      serverIdOf: () => "srv",
      localReady: () => loaded,
      whenLocalReady(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as HostsService;
    const load = () => {
      loaded = true;
      registry.replaceHost(LOCAL, [{ agent: agent("a", "running", { turnId: "t", startedAt: "2026-11-25T09:10:00.000Z" }), project: null }]);
      for (const listener of listeners) listener();
    };
    return { feed: createFeed(registry, needs, hosts, quietLog), load };
  }

  it("waits for this host's agents instead of pushing an empty list", async () => {
    vi.useFakeTimers();
    const { feed, load } = setup(false);
    const pushes: number[] = [];
    feed.addLive(async (snapshot) => void pushes.push(snapshot.agents.length));
    expect(pushes).toEqual([]);
    load();
    expect(pushes).toEqual([1]);
    feed.stop();
  });

  it("pushes anyway after 3 s if the read hasn't finished", async () => {
    vi.useFakeTimers();
    const { feed } = setup(false);
    const pushes: number[] = [];
    feed.addLive(async (snapshot) => void pushes.push(snapshot.agents.length));
    vi.advanceTimersByTime(3_000);
    expect(pushes).toEqual([0]);
    feed.stop();
  });

  it("pushes at once when the agents are already read", async () => {
    const { feed } = setup(true);
    const pushes: number[] = [];
    feed.addLive(async (snapshot) => void pushes.push(snapshot.agents.length));
    expect(pushes).toEqual([0]);
    feed.stop();
  });
});
