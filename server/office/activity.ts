/**
 * Office tab, live part: follows the timeline of every working agent on this host, so the Office
 * tab can show what each one is doing right now and which in-agent subagents it handed work to.
 *
 * Uses `paseo.agents.ref(id).timeline.subscribe` (Paseo 0.17.4): live events only, no history.
 * So when it starts following, and after a reconnect (`subscription_restored`), it also reads the
 * current turn with `timeline.refetch` to catch up on handoffs it missed.
 *
 * One subscription per working agent. It is released a short while after the agent goes idle,
 * and every subscription is released on stop. Agents on other hosts are not followed: their
 * plugin copy has their timelines.
 */
import type { Helper, NowKind } from "../../shared/live";
import type { PluginLogger } from "../log";
import type { PaseoApi } from "../paseo/adapter";
import { LOCAL, type Registry } from "../live/registry";
import { applyItem, emptyActivity, endTurn, helpersOf, type Activity } from "./model";

const FEATURE = "office";
/** Keep following an agent this long after it goes idle: a follow-up turn often starts at once. */
const RELEASE_AFTER_MS = 60_000;

export interface AgentActivity {
  now: string | null;
  nowKind: NowKind | null;
  helpers: Helper[];
}

export interface ActivityTracker {
  start(api: PaseoApi): void;
  get(agentId: string, at?: number): AgentActivity;
  /** How many agents are followed right now (for the log and tests). */
  following(): number;
  stop(): void;
}

interface Follow {
  release: () => void;
  idleSince: number | null;
}

export function createActivityTracker(
  registry: Registry,
  log: PluginLogger,
  changed: () => void,
  now: () => number = Date.now,
): ActivityTracker {
  const activities = new Map<string, Activity>();
  const follows = new Map<string, Follow>();
  let api: PaseoApi | null = null;
  let offRegistry: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  function activityOf(agentId: string): Activity {
    let activity = activities.get(agentId);
    if (!activity) {
      activity = emptyActivity();
      activities.set(agentId, activity);
    }
    return activity;
  }

  function onEvent(agentId: string, payload: unknown): void {
    const event = (payload as { event?: { type?: string; item?: unknown; error?: string } } | null)?.event;
    if (!event?.type) return;
    const at = now();
    const activity = activityOf(agentId);
    let dirty = false;
    switch (event.type) {
      case "timeline":
        dirty = applyItem(activity, event.item, at);
        break;
      case "turn_completed":
        dirty = endTurn(activity, at, "completed");
        break;
      case "turn_failed":
        dirty = endTurn(activity, at, "failed");
        break;
      case "turn_canceled":
        dirty = endTurn(activity, at, "canceled");
        break;
      case "subscription_restored":
        // Events may have been missed while the feed was down: read the current turn again.
        backfill(agentId);
        break;
      case "error":
        log.warn(FEATURE, `Timeline feed for ${agentId} stopped`, event.error);
        follows.delete(agentId);
        break;
      default:
        break;
    }
    if (dirty) changed();
  }

  function follow(agentId: string): void {
    if (!api || follows.has(agentId)) return;
    try {
      const subscription = api.agents.ref(agentId).timeline.subscribe((payload) => onEvent(agentId, payload));
      const release = () => {
        void Promise.resolve(subscription.release()).catch((error: unknown) => log.warn(FEATURE, `Could not release the timeline feed for ${agentId}`, error));
      };
      follows.set(agentId, { release, idleSince: null });
      // The feed is live only. Read the current turn so a desk shows up even when the handoff
      // happened before we started following (plugin reload, daemon restart, Office opened late).
      backfill(agentId);
    } catch (error) {
      log.error(FEATURE, `Could not follow ${agentId}`, error);
    }
  }

  function backfill(agentId: string): void {
    const paseo = api;
    if (!paseo) return;
    void paseo.agents
      .ref(agentId)
      .timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true })
      .then((page) => {
        const activity = activityOf(agentId);
        let dirty = false;
        for (const entry of page.entries) {
          const at = Date.parse(entry.timestamp);
          dirty = applyItem(activity, entry.item, Number.isFinite(at) ? at : now()) || dirty;
        }
        if (dirty) changed();
      })
      .catch((error: unknown) => log.warn(FEATURE, `Could not read the current turn of ${agentId}`, error instanceof Error ? error.message : String(error)));
  }

  function unfollow(agentId: string): void {
    follows.get(agentId)?.release();
    follows.delete(agentId);
  }

  /** Follow working agents, release ones idle for a while, forget agents that are gone. */
  function sync(): void {
    if (!api) return;
    const at = now();
    const entries = new Map(registry.entries(LOCAL).map((entry) => [entry.id, entry]));
    for (const entry of entries.values()) {
      const running = entry.lifecycle === "running" || entry.lifecycle === "initializing";
      const followed = follows.get(entry.id);
      if (running) {
        if (followed) followed.idleSince = null;
        else follow(entry.id);
      } else if (followed) {
        followed.idleSince ??= at;
        if (at - followed.idleSince > RELEASE_AFTER_MS || entry.lifecycle === "closed") unfollow(entry.id);
      }
    }
    for (const agentId of [...follows.keys()]) if (!entries.has(agentId)) unfollow(agentId);
    for (const agentId of [...activities.keys()]) if (!entries.has(agentId)) activities.delete(agentId);
  }

  return {
    start(paseo) {
      if (api) return;
      api = paseo;
      offRegistry = registry.onChange(() => {
        try {
          sync();
        } catch (error) {
          log.error(FEATURE, "Sync failed", error);
        }
      });
      sync();
      // Idle agents are released on a timer too, in case nothing else changes for a while.
      timer = setInterval(() => {
        try {
          sync();
        } catch (error) {
          log.error(FEATURE, "Sync failed", error);
        }
      }, RELEASE_AFTER_MS / 2);
      timer.unref?.();
      log.info(FEATURE, "Following working agents for the Office tab", { following: follows.size });
    },
    get(agentId, at = now()) {
      const activity = activities.get(agentId);
      if (!activity) return { now: null, nowKind: null, helpers: [] };
      return { now: activity.now, nowKind: activity.nowKind, helpers: helpersOf(activity, at) };
    },
    following: () => follows.size,
    stop() {
      offRegistry?.();
      offRegistry = null;
      if (timer) clearInterval(timer);
      timer = null;
      for (const agentId of [...follows.keys()]) unfollow(agentId);
      activities.clear();
      api = null;
    },
  };
}
