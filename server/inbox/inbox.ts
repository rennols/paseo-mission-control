/**
 * The Review inbox for this host: agents that finished with changes still in their worktree,
 * oldest first.
 *
 * Hooks used (Paseo 0.17.4, `server.addHook`):
 * - agent.turn.after (completed): after the handler returns, reads the worktree with git and the
 *   turn's final message, then adds or refreshes the item. A turn that ends with a question is left
 *   to Needs you. Workers (agents with a parent) are skipped: they share their parent's worktree.
 * - agent.turn.before: the agent is working again, so its open item leaves the inbox.
 * - agent.archive.after: its item leaves the inbox.
 *
 * Actions run only from a click: Commit and open PR (./publish.ts) and Send back (the note becomes
 * the agent's next prompt). Open items are re-checked when the tab opens, and drop out once their
 * worktree has nothing left to review (for example after a manual merge).
 */
import type { PaseoApi } from "@getpaseo/client";
import type { ActionResult } from "../../shared/live";
import type { InboxItem, InboxSnapshot } from "../../shared/queue";
import { LOCAL, type Registry } from "../live/registry";
import type { PluginLogger } from "../log";
import type { PaseoAdapter } from "../paseo/adapter";
import type { StateStore } from "../state/store";
import { trailingQuestion } from "../watchdog/turn";
import { commitPushAndOpenPr } from "./publish";
import { hasChanges, readReview, type ReviewState } from "./review-git";

const FEATURE = "inbox";
const KEEP_RESOLVED_MS = 24 * 60 * 60_000;
const SUMMARY_CHARS = 1_500;

export interface InboxDeps {
  /** The queue task an agent ran, for its base branch. */
  taskForAgent(agentId: string): { id: string; baseRef: string | null } | undefined;
}

export interface Inbox {
  snapshot(hostLabel: string): InboxSnapshot;
  openCount(): number;
  /** Re-reads open items' worktrees; drops those with nothing left to review. */
  recheck(): Promise<void>;
  openPr(input: { itemId: string; title: string }): Promise<{ ok: boolean; message: string; prUrl: string | null }>;
  sendBack(paseo: PaseoApi, input: { itemId: string; note: string }): Promise<ActionResult>;
  onChange(listener: () => void): () => void;
  stop(): void;
}

/** The text of the turn's last assistant message run (after its last tool call). */
export function finalMessage(items: readonly unknown[]): string | null {
  const parts: string[] = [];
  for (const raw of items) {
    const item = raw as { type?: string; text?: unknown };
    if (item.type === "tool_call") parts.length = 0;
    else if (item.type === "assistant_message" && typeof item.text === "string") parts.push(item.text);
  }
  const text = parts.join("").trim();
  if (!text) return null;
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : text;
}

export function createInbox(
  adapter: PaseoAdapter,
  registry: Registry,
  store: StateStore,
  deps: InboxDeps,
  log: PluginLogger,
  now: () => number = Date.now,
): Inbox {
  const listeners = new Set<() => void>();
  const busy = new Set<string>();
  const items = () => store.state.inbox;

  function changed(): void {
    store.changed();
    for (const listener of listeners) listener();
  }

  function find(itemId: string): InboxItem | undefined {
    return items().find((item) => item.id === itemId);
  }

  function drop(agentId: string, reason: string): void {
    const before = items().length;
    store.state.inbox = items().filter((item) => !(item.agentId === agentId && item.state === "open"));
    if (items().length !== before) {
      log.info(FEATURE, `Removed from the inbox: ${reason}`, { agentId });
      changed();
    }
  }

  function apply(item: InboxItem, review: ReviewState): void {
    item.branch = review.branch;
    item.baseBranch = review.baseBranch;
    item.files = review.files;
    item.linesAdded = review.linesAdded;
    item.linesRemoved = review.linesRemoved;
    item.uncommitted = review.uncommitted;
    item.commitsAhead = review.commitsAhead;
    item.diffExcerpt = review.diffExcerpt;
    item.diffTruncated = review.diffTruncated;
  }

  async function collect(paseo: PaseoApi, agentId: string, cwd: string, turnId: string | null): Promise<void> {
    const task = deps.taskForAgent(agentId);
    const review = await readReview(cwd, task?.baseRef ?? null);
    if (!review || !hasChanges(review)) {
      drop(agentId, review ? "no changes left" : "not a git worktree");
      return;
    }
    let summary: string | null = null;
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
      const turn = page.entries.filter((entry) => !turnId || entry.turnId === turnId).map((entry) => entry.item as unknown);
      summary = finalMessage(turn);
    } catch (error) {
      log.warn(FEATURE, "Could not read the agent's final message", error instanceof Error ? error.message : String(error));
    }
    if (trailingQuestion(summary)) {
      // It ended by asking something: that is a Needs you question, not finished work.
      drop(agentId, "ended with a question");
      return;
    }
    const entry = registry.get(LOCAL, agentId);
    const existing = items().find((item) => item.agentId === agentId && item.state === "open");
    const item: InboxItem = existing ?? {
      id: agentId,
      agentId,
      title: entry?.title ?? "Agent",
      provider: entry?.provider ?? "agent",
      workspaceName: entry?.workspaceName ?? entry?.projectName ?? (cwd.split(/[\\/]/).filter(Boolean).pop() || "Workspace"),
      branch: null,
      baseBranch: null,
      cwd,
      finishedAt: now(),
      taskId: task?.id ?? null,
      summary: null,
      failedChecks: [],
      files: [],
      linesAdded: 0,
      linesRemoved: 0,
      uncommitted: false,
      commitsAhead: 0,
      diffExcerpt: "",
      diffTruncated: false,
      state: "open",
      prUrl: null,
      resolvedAt: null,
      resolution: null,
    };
    if (existing) {
      existing.finishedAt = now();
      if (entry?.title) existing.title = entry.title;
    } else {
      // An older resolved item for the same agent is replaced by the new one.
      store.state.inbox = items().filter((candidate) => candidate.id !== agentId);
      items().push(item);
    }
    item.summary = summary;
    apply(item, review);
    log.info(FEATURE, `Ready for review: ${item.title}`, { agentId, files: item.files.length, commitsAhead: item.commitsAhead, uncommitted: item.uncommitted });
    changed();
  }

  const removers = [
    adapter.addHook("agent.turn.after", FEATURE, async ({ agent, turnId, outcome }) => {
      if (agent.background || agent.parentAgentId || outcome.kind !== "completed" || !agent.cwd) return;
      adapter.defer(FEATURE, "review read", (paseo) => collect(paseo, agent.id, agent.cwd, turnId ?? null));
    }),
    adapter.addHook("agent.turn.before", FEATURE, async ({ agent }) => {
      if (!busy.has(agent.id)) drop(agent.id, "working again");
    }),
    adapter.addHook("agent.archive.after", FEATURE, async ({ agent }) => {
      drop(agent.id, "agent archived");
    }),
  ];

  function prune(): void {
    const at = now();
    const kept = items().filter((item) => item.resolvedAt === null || at - item.resolvedAt < KEEP_RESOLVED_MS);
    if (kept.length !== items().length) {
      store.state.inbox = kept;
      store.changed();
    }
  }

  return {
    snapshot(hostLabel) {
      prune();
      const open = items().filter((item) => item.state === "open").sort((a, b) => a.finishedAt - b.finishedAt);
      const resolved = items().filter((item) => item.state !== "open").sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
      return { generatedAt: now(), hostLabel, items: [...open, ...resolved] };
    },

    openCount: () => items().filter((item) => item.state === "open").length,

    async recheck() {
      for (const item of items().filter((candidate) => candidate.state === "open")) {
        if (busy.has(item.id)) continue;
        const task = deps.taskForAgent(item.agentId);
        const review = await readReview(item.cwd, task?.baseRef ?? item.baseBranch);
        if (!review || !hasChanges(review)) drop(item.agentId, "nothing left to review");
        else {
          apply(item, review);
          changed();
        }
      }
    },

    async openPr({ itemId, title }) {
      const item = find(itemId);
      if (!item || item.state !== "open") return { ok: false, message: "That item is no longer in the inbox.", prUrl: null };
      if (busy.has(itemId)) return { ok: false, message: "Already working on it.", prUrl: null };
      busy.add(itemId);
      try {
        const body = [item.summary ?? `Changes by ${item.title}.`, "", `_Opened from Mission Control (Paseo) after review._`].join("\n");
        log.info(FEATURE, `Commit and open PR: ${item.title}`, { agentId: item.agentId, cwd: item.cwd, base: item.baseBranch });
        const result = await commitPushAndOpenPr({ cwd: item.cwd, title, body, baseBranch: item.baseBranch });
        if (result.ok) {
          item.state = "pr_opened";
          item.prUrl = result.prUrl;
          item.resolvedAt = now();
          item.resolution = result.prUrl ? `PR opened: ${result.prUrl}` : result.message;
          log.info(FEATURE, `PR opened for ${item.title}`, { prUrl: result.prUrl });
          changed();
        } else {
          log.warn(FEATURE, `Commit and open PR failed at ${result.step}`, result.message);
          // The worktree may have changed (a commit went through); show the new state.
          const review = await readReview(item.cwd, item.baseBranch);
          if (review) {
            apply(item, review);
            changed();
          }
        }
        return { ok: result.ok, message: result.message, prUrl: result.prUrl };
      } finally {
        busy.delete(itemId);
      }
    },

    async sendBack(paseo, { itemId, note }) {
      const item = find(itemId);
      if (!item || item.state !== "open") return { ok: false, message: "That item is no longer in the inbox." };
      busy.add(itemId);
      try {
        await paseo.agents.ref(item.agentId).send(note);
        item.state = "sent_back";
        item.resolvedAt = now();
        item.resolution = `Sent back: ${note.length > 120 ? `${note.slice(0, 119)}…` : note}`;
        log.info(FEATURE, `Sent back: ${item.title}`, { agentId: item.agentId });
        changed();
        return { ok: true, message: `Sent to ${item.title}.` };
      } catch (error) {
        return { ok: false, message: `Could not send: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        busy.delete(itemId);
      }
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    stop() {
      for (const remove of removers) remove();
    },
  };
}
