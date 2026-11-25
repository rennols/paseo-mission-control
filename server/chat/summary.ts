/**
 * Turn summary cards (PRD: Chat, Turn summary card).
 *
 * Hooks used (Paseo 0.17.4, `server.addHook`):
 * - agent.turn.before: notes the start time and snapshots the worktree (git, after the handler returns).
 * - agent.turn.after: snapshots again, diffs the two, reads the turn's tool calls for checks and the
 *   final message for a question, and appends one card to the agent's timeline with
 *   `paseo.agents.ref(id).timeline.append`, row id `turn-summary:<turn id>`.
 *
 * Paseo 0.17.4 drops appended plugin rows when the daemon restarts (checked on a real daemon). Cards
 * are not appended again afterwards: a re-appended row lands after the turn and stretches Paseo's
 * own "Worked for" time for that turn. The copy in the state file stays for the review inbox.
 *
 * Only turns that changed files or ran checks get a card. Checks come only from commands the agent
 * already ran; the plugin never runs a check. A failure here is logged and never reaches the watchdog.
 */
import type { PaseoApi } from "@getpaseo/client";
import path from "node:path";
import {
  SUMMARY_KIND,
  SUMMARY_VERSION,
  TurnSummarySchema,
  type ChatSettings,
  type TurnSummary,
} from "../../shared/chat";
import type { PluginLogger } from "../log";
import type { PaseoAdapter } from "../paseo/adapter";
import type { StateStore } from "../state/store";
import { analyseTurn } from "../watchdog/turn";
import { collectChecks } from "./checks";
import { diffSnapshots, takeSnapshot, type Snapshot } from "./snapshot";

const FEATURE = "summary";
/** Summaries kept in the state file per host, newest last. */
export const KEPT_SUMMARIES = 200;

interface TurnStart {
  startedAt: number;
  snapshot: Promise<Snapshot | null>;
}

export interface SummaryService {
  stop(): void;
}


/** The card row id for a turn. Reusing it replaces the row. */
export function rowId(turnId: string): string {
  return `turn-summary:${turnId}`;
}

/** PRD: only turns that changed files or ran checks get a card. */
export function deservesCard(summary: Pick<TurnSummary, "files" | "moreFiles" | "checks">): boolean {
  return summary.files.length + summary.moreFiles > 0 || summary.checks.length > 0;
}

export function createSummaryService(
  adapter: PaseoAdapter,
  store: StateStore,
  settings: () => ChatSettings,
  stateDirectory: string,
  log: PluginLogger,
  /** Called after a summary is stored (the overnight report and the collision radar read them). */
  onSaved: (summary: TurnSummary, root: string | null) => void = () => undefined,
  /** Snapshot turns even with the card off (the collision radar reads the trees). */
  alsoTrack: () => boolean = () => false,
): SummaryService {
  const tracking = () => settings().summaryCard || alsoTrack();
  const starts = new Map<string, TurnStart>();
  const scratch = path.join(stateDirectory, "snapshots");

  function snapshot(cwd: string): Promise<Snapshot | null> {
    // Started after the hook handler returns; the promise is awaited by the turn's end.
    return new Promise((resolve) => {
      setImmediate(() => {
        takeSnapshot(cwd, scratch).then(resolve, (error: unknown) => {
          log.error(FEATURE, "Snapshot failed", error);
          resolve(null);
        });
      });
    });
  }

  function remember(summary: TurnSummary, root: string | null): void {
    const list = store.state.summaries.filter((entry) => !(entry.agentId === summary.agentId && entry.turnId === summary.turnId));
    list.push(summary);
    store.state.summaries = list.slice(-KEPT_SUMMARIES);
    store.changed();
    onSaved(summary, root);
  }

  async function summarise(
    paseo: PaseoApi,
    agentId: string,
    turnId: string,
    outcome: TurnSummary["outcome"],
    start: TurnStart | undefined,
    afterSnapshot: Promise<Snapshot | null>,
    endedAt: number,
  ): Promise<void> {
    const current = settings();
    const before = start ? await start.snapshot : null;
    const after = await afterSnapshot;
    const diff = before && after && before.root === after.root ? await diffSnapshots(before, after) : null;

    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
    const items = page.entries.filter((entry) => entry.turnId === turnId).map((entry) => entry.item as unknown);
    if (items.length === 0) {
      // A newer turn already started (step 0, finding 4). PRD: an empty read gives no card.
      log.info(FEATURE, `Turn ${turnId} of ${agentId} not readable; no card`);
      return;
    }
    const facts = analyseTurn(items);
    const summary = TurnSummarySchema.parse({
      agentId,
      turnId,
      startedAt: start?.startedAt ?? endedAt,
      endedAt,
      outcome,
      filesTracked: diff !== null,
      files: diff?.files ?? [],
      moreFiles: diff?.moreFiles ?? 0,
      totalAdded: diff?.totalAdded ?? 0,
      totalRemoved: diff?.totalRemoved ?? 0,
      checks: collectChecks(items, current.checkPatterns),
      question: outcome === "completed" ? facts.asksQuestion : null,
      trees: before && after ? { before: before.tree, after: after.tree } : null,
    });

    log.info(FEATURE, "Turn summary", {
      agentId,
      turnId,
      root: after?.root ?? null,
      trees: summary.trees,
      files: summary.files.map((file) => file.path),
      moreFiles: summary.moreFiles,
      checks: summary.checks.map((check) => `${check.passed ? "passed" : "failed"}: ${check.command}`),
      question: summary.question,
      card: deservesCard(summary),
    });
    // Turns with no changes and no checks are stored too (no card), so the overnight report can
    // say "No file changes" from git instead of guessing.
    if (summary.filesTracked || deservesCard(summary)) remember(summary, after?.root ?? null);
    if (!deservesCard(summary) || !current.summaryCard) return;
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: rowId(turnId),
      kind: SUMMARY_KIND,
      version: SUMMARY_VERSION,
      data: summary,
    });
  }

  const removers = [
    adapter.addHook("agent.turn.before", FEATURE, async ({ agent }) => {
      if (agent.background || !tracking() || !agent.cwd) {
        starts.delete(agent.id);
        return;
      }
      starts.set(agent.id, { startedAt: Date.now(), snapshot: snapshot(agent.cwd) });
    }),

    adapter.addHook("agent.turn.after", FEATURE, async ({ agent, turnId, outcome }) => {
      const start = starts.get(agent.id);
      starts.delete(agent.id);
      if (agent.background || !tracking() || !turnId || !agent.cwd) return;
      const endedAt = Date.now();
      // Taken at once (after the handler returns), so the next turn's edits can't leak in.
      const after = start ? snapshot(agent.cwd) : Promise.resolve(null);
      adapter.defer(FEATURE, "turn summary", (paseo) =>
        summarise(paseo, agent.id, turnId, outcome.kind, start, after, endedAt),
      );
    }),

    adapter.addHook("agent.archive.after", FEATURE, async ({ agent }) => {
      starts.delete(agent.id);
    }),
  ];

  return {
    stop() {
      for (const remove of removers) remove();
      starts.clear();
    },
  };
}
