/**
 * Pushes Live snapshots to every open Live tab and the open count to every sidebar entry.
 * Changes are coalesced (at most one push per 250 ms), and a snapshot is pushed every 15 s while
 * someone listens so lanes keep moving. The client never polls.
 */
import type { LiveSnapshot } from "../../shared/live";
import type { PluginLogger } from "../log";
import type { NeedsStore } from "../needs/needs";
import type { HostsService } from "./hosts";
import type { Registry } from "./registry";

const FEATURE = "live";
const COALESCE_MS = 250;
const HEARTBEAT_MS = 15_000;

type Push<T> = (event: T) => Promise<void>;

export interface Feed {
  /** Registers a Live tab. Sends the first snapshot at once. Returns a remover. */
  addLive(push: Push<LiveSnapshot>): () => void;
  /** Registers a sidebar entry. Sends the count at once. Returns a remover. */
  addCount(push: Push<{ open: number }>): () => void;
  changed(): void;
  snapshot(): LiveSnapshot;
  stop(): void;
}

export function createFeed(registry: Registry, needs: NeedsStore, hosts: HostsService, log: PluginLogger): Feed {
  const live = new Set<Push<LiveSnapshot>>();
  const counts = new Set<Push<{ open: number }>>();
  let pending: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let lastCount = -1;

  function snapshot(): LiveSnapshot {
    const now = Date.now();
    registry.refresh(now);
    return {
      generatedAt: now,
      self: hosts.self(),
      hosts: hosts.summaries(),
      agents: registry.rows(hosts.labels(), hosts.serverIdOf, now),
      needs: needs.list(now),
    };
  }

  function send<T>(targets: Set<Push<T>>, event: T): void {
    for (const push of targets) {
      push(event).catch((error: unknown) => log.warn(FEATURE, "Push failed", error instanceof Error ? error.message : String(error)));
    }
  }

  function flush(force: boolean): void {
    pending = null;
    try {
      if (live.size > 0) send(live, snapshot());
      const open = needs.openCount();
      if (counts.size > 0 && (force || open !== lastCount)) send(counts, { open });
      lastCount = open;
    } catch (error) {
      log.error(FEATURE, "Could not build the Live snapshot", error);
    }
  }

  function changed(): void {
    if (pending) return;
    pending = setTimeout(() => flush(false), COALESCE_MS);
  }

  function ensureHeartbeat(): void {
    if (heartbeat || live.size === 0) return;
    heartbeat = setInterval(() => {
      if (live.size === 0) {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        return;
      }
      flush(false);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  const offRegistry = registry.onChange(changed);
  const offNeeds = needs.onChange(changed);

  return {
    addLive(push) {
      live.add(push);
      push(snapshot()).catch((error: unknown) => log.warn(FEATURE, "First push failed", error instanceof Error ? error.message : String(error)));
      ensureHeartbeat();
      return () => live.delete(push);
    },
    addCount(push) {
      counts.add(push);
      push({ open: needs.openCount() }).catch(() => undefined);
      return () => counts.delete(push);
    },
    changed,
    snapshot,
    stop() {
      offRegistry();
      offNeeds();
      if (pending) clearTimeout(pending);
      if (heartbeat) clearInterval(heartbeat);
      live.clear();
      counts.clear();
    },
  };
}
