/**
 * The Needs you list for this host. Items persist in the state file, so open cards survive a
 * daemon restart; permission cards are reconciled against Paseo's pending requests once the SDK
 * is available again.
 *
 * Nothing here answers anything on the user's behalf. Cards open and close from hooks; the only
 * actions are the RPCs in ./actions.ts, each started by a click.
 */
import { randomUUID } from "node:crypto";
import type { NeedsItem, NeedsKind } from "../../shared/live";
import type { StateStore } from "../state/store";

const KEEP_RESOLVED_MS = 10 * 60_000;
const FORGET_RESOLVED_MS = 24 * 60 * 60_000;
const URGENCY: Record<NeedsKind, number> = { permission: 0, question: 1, stuck: 2, overtime: 3, collision: 4 };

export interface PendingRequest {
  requestId: string;
  title: string;
  detail: string | null;
}

export interface NeedsStore {
  list(now?: number): NeedsItem[];
  openCount(): number;
  get(itemId: string): NeedsItem | undefined;
  openFor(agentId: string, kind?: NeedsKind): NeedsItem[];
  addPermission(agentId: string, agentTitle: string, request: PendingRequest): void;
  /** Removes one request from the agent's permission card; resolves the card when it is empty. */
  closePermission(agentId: string, requestId: string, resolution: string): void;
  openQuestion(
    agentId: string,
    agentTitle: string,
    source: "tool" | "text",
    question: string,
    options: { label: string; description?: string }[],
    requestId: string | null,
  ): void;
  raise(agentId: string, agentTitle: string, kind: "stuck" | "overtime", title: string, detail: string | null): NeedsItem;
  /**
   * Opens or updates the collision card for one agent pair (`key`). `agentId` is the agent whose
   * turn found the overlap; `relatedAgentIds` the other one.
   */
  raiseKeyed(
    key: string,
    agentId: string,
    agentTitle: string,
    relatedAgentIds: string[],
    title: string,
    detail: string | null,
  ): NeedsItem;
  /** The open card for a key, if any. */
  openKeyed(key: string): NeedsItem | undefined;
  /** Open collision cards that name this agent, as the main or a related agent. */
  openInvolving(agentId: string, kind: NeedsKind): NeedsItem[];
  resolve(itemId: string, resolution: string): NeedsItem | undefined;
  resolveFor(agentId: string, kinds: NeedsKind[] | "all", resolution: string): void;
  /** Agent titles change after creation (Paseo names agents from the first prompt). */
  retitle(agentId: string, agentTitle: string): void;
  onChange(listener: () => void): () => void;
}

export function createNeedsStore(store: StateStore, now: () => number = Date.now): NeedsStore {
  const listeners = new Set<() => void>();
  const items = () => store.state.needs;

  function changed(): void {
    store.changed();
    for (const listener of listeners) listener();
  }

  function open(agentId: string, kind?: NeedsKind): NeedsItem[] {
    return items().filter((item) => item.agentId === agentId && item.resolvedAt === null && (!kind || item.kind === kind));
  }

  function create(
    partial: Omit<NeedsItem, "id" | "openedAt" | "resolvedAt" | "resolution" | "relatedAgentIds" | "key"> &
      Partial<Pick<NeedsItem, "relatedAgentIds" | "key">>,
  ): NeedsItem {
    const item: NeedsItem = {
      relatedAgentIds: [],
      key: null,
      ...partial,
      id: randomUUID(),
      openedAt: now(),
      resolvedAt: null,
      resolution: null,
    };
    items().push(item);
    return item;
  }

  function markResolved(item: NeedsItem, resolution: string): void {
    item.resolvedAt = now();
    item.resolution = resolution;
  }

  function prune(at: number): void {
    const keep = items().filter((item) => item.resolvedAt === null || at - item.resolvedAt < FORGET_RESOLVED_MS);
    if (keep.length !== items().length) {
      store.state.needs = keep;
      store.changed();
    }
  }

  return {
    list(at = now()) {
      prune(at);
      const openItems = items()
        .filter((item) => item.resolvedAt === null)
        .sort((a, b) => URGENCY[a.kind] - URGENCY[b.kind] || a.openedAt - b.openedAt);
      const recent = items()
        .filter((item) => item.resolvedAt !== null && at - item.resolvedAt < KEEP_RESOLVED_MS)
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
      return [...openItems, ...recent];
    },
    openCount: () => items().filter((item) => item.resolvedAt === null).length,
    get: (itemId) => items().find((item) => item.id === itemId),
    openFor: open,

    addPermission(agentId, agentTitle, request) {
      const [card] = open(agentId, "permission");
      if (card) {
        if (card.requests.some((existing) => existing.requestId === request.requestId)) return;
        card.requests.push(request);
        card.title = request.title;
        card.detail = request.detail;
      } else {
        create({
          agentId,
          agentTitle,
          kind: "permission",
          title: request.title,
          detail: request.detail,
          requests: [request],
          options: [],
          questionSource: null,
        });
      }
      changed();
    },

    closePermission(agentId, requestId, resolution) {
      for (const card of open(agentId)) {
        if (card.kind === "question" && card.requests.some((r) => r.requestId === requestId)) {
          markResolved(card, resolution);
          changed();
          return;
        }
        if (card.kind !== "permission") continue;
        const before = card.requests.length;
        card.requests = card.requests.filter((r) => r.requestId !== requestId);
        if (card.requests.length === before) continue;
        const last = card.requests[card.requests.length - 1];
        if (last) {
          card.title = last.title;
          card.detail = last.detail;
        } else {
          markResolved(card, resolution);
        }
        changed();
        return;
      }
    },

    openQuestion(agentId, agentTitle, source, question, options, requestId) {
      // One open text question per agent: a newer turn's question replaces the older one.
      if (source === "text") for (const old of open(agentId, "question")) if (old.questionSource === "text") markResolved(old, "Replaced by a newer question");
      create({
        agentId,
        agentTitle,
        kind: "question",
        title: question,
        detail: null,
        requests: requestId ? [{ requestId, title: question, detail: null }] : [],
        options,
        questionSource: source,
      });
      changed();
    },

    raise(agentId, agentTitle, kind, title, detail) {
      const [existing] = open(agentId, kind);
      if (existing) {
        if (existing.title !== title || existing.detail !== detail) {
          existing.title = title;
          existing.detail = detail;
          changed();
        }
        return existing;
      }
      const item = create({ agentId, agentTitle, kind, title, detail, requests: [], options: [], questionSource: null });
      if (kind === "stuck") store.state.metrics.stuckRaised += 1;
      changed();
      return item;
    },

    raiseKeyed(key, agentId, agentTitle, relatedAgentIds, title, detail) {
      const existing = items().find((item) => item.key === key && item.resolvedAt === null);
      if (existing) {
        const same =
          existing.agentId === agentId &&
          existing.title === title &&
          existing.detail === detail &&
          existing.relatedAgentIds.join("|") === relatedAgentIds.join("|");
        if (!same) {
          existing.agentId = agentId;
          existing.agentTitle = agentTitle;
          existing.relatedAgentIds = relatedAgentIds;
          existing.title = title;
          existing.detail = detail;
          changed();
        }
        return existing;
      }
      const item = create({ agentId, agentTitle, kind: "collision", title, detail, requests: [], options: [], questionSource: null, relatedAgentIds, key });
      changed();
      return item;
    },

    openKeyed: (key) => items().find((item) => item.key === key && item.resolvedAt === null),

    openInvolving: (agentId, kind) =>
      items().filter((item) => item.resolvedAt === null && item.kind === kind && (item.agentId === agentId || item.relatedAgentIds.includes(agentId))),

    resolve(itemId, resolution) {
      const item = items().find((candidate) => candidate.id === itemId);
      if (!item || item.resolvedAt !== null) return item;
      markResolved(item, resolution);
      changed();
      return item;
    },

    resolveFor(agentId, kinds, resolution) {
      let any = false;
      for (const item of open(agentId)) {
        if (kinds !== "all" && !kinds.includes(item.kind)) continue;
        markResolved(item, resolution);
        any = true;
      }
      if (any) changed();
    },

    retitle(agentId, agentTitle) {
      let any = false;
      for (const item of items()) {
        if (item.agentId === agentId && item.resolvedAt === null && item.agentTitle !== agentTitle) {
          item.agentTitle = agentTitle;
          any = true;
        }
      }
      if (any) changed();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
