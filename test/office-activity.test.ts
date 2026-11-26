import { describe, expect, it, vi } from "vitest";
import { createActivityTracker } from "../server/office/activity";
import type { Registry } from "../server/live/registry";
import type { PluginLogger } from "../server/log";
import type { PaseoApi } from "../server/paseo/adapter";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as PluginLogger;

describe("activity tracker", () => {
  it("reads the last turn of an agent that was already idle, once, without a now line", async () => {
    const registry = { entries: () => [{ id: "boss", lifecycle: "idle" }], onChange: () => () => {} } as unknown as Registry;
    const at = Date.parse("2026-11-26T10:00:00Z");
    const refetch = vi.fn(async () => ({
      entries: [
        { timestamp: "2026-11-26T09:59:00Z", item: { type: "tool_call", callId: "t1", name: "Task", status: "completed", detail: { type: "sub_agent", subAgentType: "Explore", description: "Find TODOs" } } },
        { timestamp: "2026-11-26T09:59:30Z", item: { type: "assistant_message", text: "Done" } },
      ],
    }));
    const subscribe = vi.fn();
    const api = { agents: { ref: () => ({ timeline: { refetch, subscribe } }) } } as unknown as PaseoApi;
    const changed = vi.fn();
    const tracker = createActivityTracker(registry, log, changed, () => at);
    tracker.start(api);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(tracker.get("boss")).toMatchObject({ now: null, helpers: [{ ask: "Find TODOs", status: "done" }] });
    expect(subscribe).not.toHaveBeenCalled();
    expect(tracker.following()).toBe(0);
    tracker.stop();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
