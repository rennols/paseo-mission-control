/**
 * The watchdog and the hook side of Needs you, for this host.
 *
 * Hooks used (Paseo 0.17.4, `server.addHook`):
 * - agent.create.after: registers the agent (nesting comes from `parentAgentId`).
 * - agent.turn.before: run start, closes a text question (the user answered), git baseline.
 * - agent.turn.after: reads the turn, counts repeats and turns without changes, raises Stuck,
 *   opens a text Question, closes Over time.
 * - agent.permission.before / .after: Permission and tool Question cards, closed by whoever answered.
 * - agent.archive.after: closes the agent's cards.
 *
 * Every handler only updates memory and returns; timeline reads and git run in `defer`.
 * The watchdog only flags. It never pauses, stops, sends or answers anything.
 */
import type { PaseoApi } from "@getpaseo/client";
import type { WatchdogSettings } from "../../shared/settings";
import { LOCAL, type Registry } from "../live/registry";
import type { PluginLogger } from "../log";
import type { NeedsStore } from "../needs/needs";
import type { HookAgent, PaseoAdapter } from "../paseo/adapter";
import type { StateStore } from "../state/store";
import { readWorktree } from "./git";
import { EMPTY_COUNTERS, applyTurn, describeTrip, isOverTime, type AgentCounters } from "./rules";
import { analyseTurn } from "./turn";

const FEATURE = "watchdog";
const TIMER_MS = 60_000;

/** Permission request as the hook gives it (SDK `AgentPermissionRequest`), read loosely. */
interface PermissionRequest {
  id: string;
  name?: string;
  kind?: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: { type?: string; command?: string; filePath?: string } & Record<string, unknown>;
}

export function describePermission(request: PermissionRequest): { title: string; detail: string | null } {
  const detail = request.detail;
  const command = detail?.type === "shell" ? detail.command : typeof request.input?.command === "string" ? request.input.command : null;
  const file = detail?.filePath ?? (typeof request.input?.file_path === "string" ? request.input.file_path : null);
  const title = request.title?.trim() || (command ? `Run ${command}` : file ? `${request.name ?? "Edit"} ${file}` : `Use ${request.name ?? "a tool"}`);
  const extra = request.description?.trim() || (command && request.title ? command : null);
  return { title: title.length > 200 ? `${title.slice(0, 199)}…` : title, detail: extra && extra !== title ? extra.slice(0, 400) : null };
}

/** Tool question (`kind: "question"`, e.g. Claude's AskUserQuestion): first question and its options. */
export function describeToolQuestion(request: PermissionRequest): { question: string; options: { label: string; description?: string }[] } {
  const questions = request.input?.questions;
  const first = Array.isArray(questions) ? (questions[0] as Record<string, unknown> | undefined) : undefined;
  const question =
    (typeof first?.question === "string" && first.question) || request.title || request.description || "The agent asked a question";
  const options = Array.isArray(first?.options)
    ? (first.options as Record<string, unknown>[])
        .filter((option) => typeof option?.label === "string")
        .map((option) => ({
          label: option.label as string,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        }))
    : [];
  const more = Array.isArray(questions) && questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
  return { question: `${question}${more}`, options };
}

function resolutionText(resolution: unknown, title: string): string {
  const record = (resolution && typeof resolution === "object" ? resolution : {}) as { behavior?: string; message?: string };
  if (record.behavior === "allow") return `Allowed. ${title} is working again.`;
  if (/dismiss/i.test(record.message ?? "")) return "Dismissed.";
  return record.message ? `Denied: ${record.message}` : "Denied.";
}

export interface Watchdog {
  /** Forgets the counts that raised Stuck, after a hint or a dismissal. */
  resetCounters(agentId: string): void;
  /** Starts the elapsed-time timer and reconciles cards with Paseo once the SDK is available. */
  start(paseo: PaseoApi): void;
  stop(): void;
}

export function createWatchdog(
  adapter: PaseoAdapter,
  registry: Registry,
  needs: NeedsStore,
  store: StateStore,
  settings: () => WatchdogSettings,
  log: PluginLogger,
): Watchdog {
  const counters = new Map<string, AgentCounters>();
  const baselines = new Map<string, string>();
  let timer: NodeJS.Timeout | null = null;

  const title = (agentId: string) => registry.get(LOCAL, agentId)?.title ?? "Agent";

  function track(agent: HookAgent): boolean {
    if (agent.background) return false;
    const entry = registry.upsertFromHook(LOCAL, agent);
    needs.retitle(agent.id, entry.title);
    return true;
  }

  function baseline(agentId: string, cwd: string): void {
    if (baselines.has(agentId) || !cwd) return;
    adapter.defer(FEATURE, "git baseline", async () => {
      const state = await readWorktree(cwd);
      if (state && !baselines.has(agentId)) baselines.set(agentId, state.fingerprint);
    });
  }

  const removers = [
    adapter.addHook("agent.create.after", FEATURE, async ({ agent }) => {
      if (track(agent)) baseline(agent.id, agent.cwd);
    }),

    adapter.addHook("agent.turn.before", FEATURE, async ({ agent }) => {
      if (!track(agent)) return;
      registry.turnStarted(LOCAL, agent.id, Date.now());
      for (const item of needs.openFor(agent.id, "question")) {
        if (item.questionSource === "text") needs.resolve(item.id, `Answered. ${title(agent.id)} is working again.`);
      }
      baseline(agent.id, agent.cwd);
    }),

    adapter.addHook("agent.turn.after", FEATURE, async ({ agent, turnId, outcome }) => {
      if (!track(agent)) return;
      const endedAt = Date.now();
      const entry = registry.get(LOCAL, agent.id);
      const runStartedAt = entry?.runStartedAt ?? null;
      registry.turnEnded(LOCAL, agent.id, endedAt, outcome.kind === "completed");
      for (const item of needs.openFor(agent.id, "overtime")) {
        const minutes = runStartedAt ? Math.round((endedAt - runStartedAt) / 60_000) : null;
        needs.resolve(item.id, minutes ? `Finished after ${minutes} min.` : "Finished.");
      }
      if (store.state.overtimeExtensions[agent.id] !== undefined) {
        delete store.state.overtimeExtensions[agent.id];
        store.changed();
      }
      if (outcome.kind === "canceled") return;

      adapter.defer(FEATURE, "turn check", async (paseo) => {
        const page = await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
        const items = turnId ? page.entries.filter((entry) => entry.turnId === turnId).map((entry) => entry.item as unknown) : [];
        if (items.length === 0) {
          // A newer turn already started, or the provider gave no turn id: nothing to judge (step 0, finding 4).
          log.info(FEATURE, `Turn ${turnId ?? "(no id)"} of ${agent.id} not readable; skipped`);
          return;
        }
        const facts = analyseTurn(items);
        if (outcome.kind === "failed") {
          const message = outcome.error.message.split("\n")[0] ?? "turn failed";
          facts.failures.push({
            command: "turn",
            errorLine: message.toLowerCase().slice(0, 200),
            signature: `turn — ${message.toLowerCase().slice(0, 200)}`,
            display: `Turn failed: ${message.slice(0, 140)}`,
          });
        }

        const worktree = agent.cwd ? await readWorktree(agent.cwd) : null;
        const before = baselines.get(agent.id);
        const changedByGit = worktree !== null && before !== undefined && worktree.fingerprint !== before;
        if (worktree) baselines.set(agent.id, worktree.fingerprint);
        const changedFiles = facts.fileEdits > 0 || changedByGit;

        const current = settings();
        const verdict = applyTurn(counters.get(agent.id) ?? EMPTY_COUNTERS, facts, changedFiles, current);
        counters.set(agent.id, verdict.counters);

        const row = registry.get(LOCAL, agent.id);
        if (row) {
          if (facts.latestActivity) row.latestActivity = facts.latestActivity;
          if (worktree) {
            row.linesAdded = worktree.linesAdded;
            row.linesRemoved = worktree.linesRemoved;
          }
        }
        if (verdict.repeated.length > 0) registry.addMark(LOCAL, agent.id, { kind: "repeat", at: endedAt });

        log.info(FEATURE, "turn checked", {
          agentId: agent.id,
          turnId,
          userStarted: facts.userStarted,
          failures: facts.failures.map((failure) => failure.signature),
          repeats: Object.fromEntries(Object.entries(verdict.counters.repeats).map(([key, value]) => [key, value.count])),
          changedFiles,
          turnsWithoutChanges: verdict.counters.turnsWithoutChanges,
          trips: verdict.trips.map(describeTrip),
        });

        if (verdict.trips.length > 0) {
          const [first] = verdict.trips;
          const reasons = verdict.trips.map(describeTrip).join(". ");
          const detail = first?.reason === "same-error" ? first.display : facts.latestActivity;
          const card = needs.raise(agent.id, title(agent.id), "stuck", reasons, detail);
          log.warn(FEATURE, `Stuck: ${title(agent.id)} (${agent.id}): ${reasons}`, { itemId: card.id, detail });
        } else if (verdict.counted) {
          needs.resolveFor(agent.id, ["stuck"], `Recovered. ${title(agent.id)} is past the error.`);
        }

        if (outcome.kind === "completed" && facts.asksQuestion) {
          needs.openQuestion(agent.id, title(agent.id), "text", facts.asksQuestion, [], null);
        }
        registry.refresh();
      });
    }),

    adapter.addHook("agent.permission.before", FEATURE, async ({ agent, request }) => {
      if (!track(agent)) return;
      const permission = request as unknown as PermissionRequest;
      if (permission.kind === "question") {
        const { question, options } = describeToolQuestion(permission);
        needs.openQuestion(agent.id, title(agent.id), "tool", question, options, permission.id);
      } else {
        const { title: requestTitle, detail } = describePermission(permission);
        needs.addPermission(agent.id, title(agent.id), { requestId: permission.id, title: requestTitle, detail });
        const row = registry.get(LOCAL, agent.id);
        if (row) row.latestActivity = `Asked: ${requestTitle}`;
      }
      registry.refresh();
    }),

    adapter.addHook("agent.permission.after", FEATURE, async ({ agent, requestId, resolution }) => {
      if (agent.background) return;
      needs.closePermission(agent.id, requestId, resolutionText(resolution, title(agent.id)));
      registry.refresh();
    }),

    adapter.addHook("agent.archive.after", FEATURE, async ({ agent }) => {
      needs.resolveFor(agent.id, "all", "Agent archived.");
      counters.delete(agent.id);
      baselines.delete(agent.id);
      registry.remove(LOCAL, agent.id);
    }),
  ];

  /** Over time: runs past the limit (plus any "Allow 30 more min"). Every 60 s. */
  function checkElapsed(): void {
    try {
      const now = Date.now();
      const current = settings();
      for (const entry of registry.entries(LOCAL)) {
        if (entry.background || entry.runStartedAt === null || entry.lifecycle !== "running") continue;
        const extra = store.state.overtimeExtensions[entry.id] ?? 0;
        if (!isOverTime(entry.runStartedAt, now, current, extra)) continue;
        const minutes = Math.round((now - entry.runStartedAt) / 60_000);
        needs.raise(entry.id, entry.title, "overtime", `Running for ${minutes} min`, `Time limit ${current.timeLimitMinutes + extra} min`);
      }
      registry.refresh(now);
    } catch (error) {
      log.error(FEATURE, "Elapsed-time check failed", error);
    }
  }

  /** After a restart: close permission cards Paseo no longer has pending, open ones it does. */
  async function reconcile(paseo: PaseoApi): Promise<void> {
    const open = needs.list().filter((item) => item.resolvedAt === null && (item.kind === "permission" || item.questionSource === "tool"));
    const agentIds = new Set(open.map((item) => item.agentId));
    for (const agentId of agentIds) {
      const result = await paseo.agents.ref(agentId).refresh().catch(() => null);
      const pending = new Set((result?.agent.pendingPermissions ?? []).map((request) => request.id));
      for (const item of open.filter((candidate) => candidate.agentId === agentId)) {
        for (const request of item.requests) {
          if (!pending.has(request.requestId)) needs.closePermission(agentId, request.requestId, "Answered while Mission Control was not running.");
        }
      }
    }
    for (const entry of registry.entries(LOCAL)) {
      if (entry.pendingPermissions === 0) continue;
      const result = await paseo.agents.ref(entry.id).refresh().catch(() => null);
      for (const request of result?.agent.pendingPermissions ?? []) {
        if (request.kind === "question") {
          if (!needs.openFor(entry.id, "question").some((item) => item.requests.some((r) => r.requestId === request.id))) {
            const { question, options } = describeToolQuestion(request as unknown as PermissionRequest);
            needs.openQuestion(entry.id, entry.title, "tool", question, options, request.id);
          }
        } else {
          const { title: requestTitle, detail } = describePermission(request as unknown as PermissionRequest);
          needs.addPermission(entry.id, entry.title, { requestId: request.id, title: requestTitle, detail });
        }
      }
    }
    registry.refresh();
  }

  return {
    resetCounters(agentId) {
      counters.delete(agentId);
    },
    start(paseo) {
      if (timer) return;
      timer = setInterval(checkElapsed, TIMER_MS);
      timer.unref?.();
      // Give the directory subscription a moment to fill the registry first.
      setTimeout(() => void reconcile(paseo).catch((error: unknown) => log.error(FEATURE, "Reconcile failed", error)), 3_000).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const remove of removers) remove();
    },
  };
}

