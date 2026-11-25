/**
 * The task queue and its dispatcher, for this host.
 *
 * The dispatcher runs when the agent list changes (a slot may have freed), every 30 s, and when a
 * task is added. It starts the first queued task while a slot is free: one call to
 * `workspaces.create` makes a worktree workspace off the project and its first agent with the
 * task's prompt. A task never starts twice:
 * - its state is written to the state file as "starting" before the call is made;
 * - the call carries an idempotency key (task id and attempt), which Paseo uses to return the same
 *   workspace for a repeated request (checked on 0.17.4);
 * - after a restart, a task left in "starting" is matched to its agent by the agent's
 *   `mission-control.task` metadata, and is never sent again.
 *
 * Unattended rule: a queue-started agent that holds a slot and changes no files for the configured
 * time (default 60 min) is stopped to free its slot. The 0.17.4 plugin SDK has no stop or cancel,
 * so "stop" is `agents.ref(id).reload()`, which interrupts the running turn and keeps the agent and
 * its chat (checked on a 0.17.4 daemon: running → idle in about 250 ms). The task is marked
 * Stopped, and its agent no longer counts against the slot limit even if it is still waiting.
 *
 * Touches processes on your machine: `git status` and `git diff` (read-only, through
 * ../watchdog/git.ts) in running tasks' worktrees once a minute. Creating workspaces makes git
 * worktrees through Paseo.
 *
 * After a daemon restart the server has no SDK until the first hook, RPC or subscription, so queued
 * work waits until an agent does something or someone opens Mission Control (step 0, finding 5).
 */
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { ActionResult } from "../../shared/live";
import type { QueueSnapshot, QueueTask } from "../../shared/queue";
import type { QueueSettings } from "../../shared/settings";
import { LOCAL, type Registry } from "../live/registry";
import type { PluginLogger } from "../log";
import type { PaseoAdapter } from "../paseo/adapter";
import type { StateStore } from "../state/store";
import { readWorktree } from "../watchdog/git";
import type { CatalogService } from "./catalog";
import {
  freeSlots,
  idempotencyKey,
  minutesBetween,
  moveUp,
  nextTask,
  orderForDisplay,
  pruneHistory,
  shouldStopUnattended,
  slotHolders,
  titleFromPrompt,
} from "./model";

const FEATURE = "queue";
const TICK_MS = 30_000;
const CHANGE_CHECK_MS = 60_000;
const REGISTRY_DEBOUNCE_MS = 1_000;
/** Workspace and agent metadata key carrying the task id. Other hosts can read it through the SDK. */
export const TASK_METADATA_KEY = "mission-control.task";

export interface AddTaskInput {
  prompt: string;
  title?: string;
  projectKey: string;
  profileKey: string;
  baseRef?: string;
}

export interface TaskQueue {
  start(paseo: PaseoApi): void;
  snapshot(hostLabel: string): QueueSnapshot;
  queuedCount(): number;
  task(taskId: string): QueueTask | undefined;
  taskForAgent(agentId: string): QueueTask | undefined;
  add(paseo: PaseoApi, input: AddTaskInput): Promise<ActionResult>;
  remove(taskId: string): ActionResult;
  moveUp(taskId: string): ActionResult;
  startNow(paseo: PaseoApi, taskId: string): Promise<ActionResult>;
  retry(taskId: string): ActionResult;
  /** Re-reads projects and profiles for the form. */
  refreshCatalog(paseo: PaseoApi): Promise<void>;
  onChange(listener: () => void): () => void;
  stop(): void;
}

export function createTaskQueue(
  adapter: PaseoAdapter,
  registry: Registry,
  store: StateStore,
  catalog: CatalogService,
  settings: () => QueueSettings,
  log: PluginLogger,
  /**
   * Closes the agent's open permission and question cards with `resolution`, before the stop.
   * Returns how many requests were open. The stop clears them in Paseo; it never approves them.
   */
  clearRequests: (agentId: string, resolution: string) => number = () => 0,
  now: () => number = Date.now,
): TaskQueue {
  const listeners = new Set<() => void>();
  const fingerprints = new Map<string, string>();
  let api: PaseoApi | null = null;
  let tickTimer: NodeJS.Timeout | null = null;
  let changeTimer: NodeJS.Timeout | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let dispatching = false;
  let again = false;
  let stopped = false;

  const tasks = () => store.state.queue;

  function changed(): void {
    store.changed();
    for (const listener of listeners) listener();
  }

  function agents() {
    return registry.entries(LOCAL).map((entry) => ({ id: entry.id, title: entry.title, status: entry.status, background: entry.background }));
  }

  function holders() {
    return slotHolders(agents(), tasks());
  }

  function finish(task: QueueTask, state: "finished" | "failed" | "stopped", outcome: string): void {
    task.state = state;
    task.finishedAt = now();
    task.outcome = outcome;
    fingerprints.delete(task.id);
    log.info(FEATURE, `Task ${state}: ${task.title}`, { taskId: task.id, agentId: task.agentId, outcome });
    changed();
  }

  async function findAgentFor(paseo: PaseoApi, task: QueueTask): Promise<{ agentId: string; workspaceId: string | null } | null> {
    const result = await paseo.agents.list();
    for (const entry of result.entries) {
      const metadata = entry.agent.metadata as Record<string, unknown> | undefined;
      if (metadata?.[TASK_METADATA_KEY] === task.id) return { agentId: entry.agent.id, workspaceId: entry.agent.workspaceId ?? null };
    }
    return null;
  }

  async function launch(paseo: PaseoApi, task: QueueTask, startedBy: "queue" | "user", overLimit: boolean): Promise<void> {
    task.state = "starting";
    task.startedAt = now();
    task.startedBy = startedBy;
    task.overLimit = overLimit;
    task.outcome = null;
    changed();
    // On disk before the create call, so a restart mid-call never sends it again.
    await store.flush();
    log.info(FEATURE, `Starting task: ${task.title}`, { taskId: task.id, startedBy, overLimit, key: idempotencyKey(task) });
    try {
      const config = await catalog.launchConfig(paseo, task.profileKey);
      const metadata = { [TASK_METADATA_KEY]: task.id };
      const workspace = await paseo.workspaces.create({
        source: {
          kind: "worktree",
          cwd: task.projectPath,
          ...(task.projectId ? { projectId: task.projectId } : {}),
          action: "branch-off",
          ...(task.baseRef ? { refName: task.baseRef } : {}),
        },
        idempotencyKey: idempotencyKey(task),
        title: task.title,
        metadata,
        agent: { cwd: task.projectPath, config, title: task.title, prompt: task.prompt, metadata },
      });
      task.workspaceId = workspace.id;
      const found = await findAgentFor(paseo, task).catch(() => null);
      task.agentId = found?.agentId ?? null;
      task.state = "running";
      task.lastChangeAt = now();
      log.info(FEATURE, `Started task: ${task.title}`, { taskId: task.id, workspaceId: workspace.id, agentId: task.agentId, provider: config.provider });
      changed();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      finish(task, "failed", `Could not start: ${text}`);
    }
  }

  /** Starts queued tasks while slots are free. Never runs twice at once. */
  async function dispatch(): Promise<void> {
    if (!api || stopped) return;
    if (dispatching) {
      again = true;
      return;
    }
    dispatching = true;
    try {
      do {
        again = false;
        for (;;) {
          const free = freeSlots(settings().slotLimit, holders());
          const task = nextTask(tasks());
          if (free <= 0 || !task) break;
          await launch(api, task, "queue", false);
        }
      } while (again);
    } catch (error) {
      log.error(FEATURE, "Dispatcher failed; retrying on the next tick", error);
    } finally {
      dispatching = false;
    }
  }

  function scheduleDispatch(): void {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void dispatch();
    }, REGISTRY_DEBOUNCE_MS);
    debounce.unref?.();
  }

  /** Once a minute: note worktree changes of running tasks, apply the unattended rule. */
  async function checkRunning(): Promise<void> {
    if (!api) return;
    const at = now();
    const busy = new Set(holders().map((holder) => holder.agentId));
    const stopMinutes = settings().unattendedStopMinutes;
    for (const task of tasks()) {
      if (task.state !== "running" || !task.agentId) continue;
      const entry = registry.get(LOCAL, task.agentId);
      // The turn can end before `workspaces.create` returns (a short task), when the hook found
      // the task still starting. The registry's finished mark catches that case.
      if (entry && entry.lifecycle === "idle" && task.startedAt !== null && entry.marks.some((mark) => mark.kind === "finished" && mark.at >= (task.startedAt as number))) {
        finish(task, "finished", `Finished after ${minutesBetween(task.startedAt, at) ?? 0} min`);
        continue;
      }
      if (entry?.cwd) {
        const worktree = await readWorktree(entry.cwd);
        if (worktree) {
          const previous = fingerprints.get(task.id);
          if (previous !== undefined && previous !== worktree.fingerprint) {
            task.lastChangeAt = at;
            store.changed();
          }
          fingerprints.set(task.id, worktree.fingerprint);
        }
      }
      if (!shouldStopUnattended(task, busy.has(task.agentId), at, stopMinutes)) continue;
      const minutes = minutesBetween(task.lastChangeAt ?? task.startedAt, at) ?? stopMinutes;
      const pending = (registry.get(LOCAL, task.agentId)?.pendingPermissions ?? 0) > 0;
      const cleared = clearRequests(task.agentId, `Cleared, not approved: the ${stopMinutes}-minute rule stopped this queue run after ${minutes} min with no file changes.`);
      const note = pending || cleared > 0 ? `. Its open permission request was cleared by the ${stopMinutes}-minute rule, not approved` : "";
      try {
        await api.agents.ref(task.agentId).reload();
        finish(task, "stopped", `Stopped by the watchdog after ${minutes} min with no file changes${note}`);
      } catch (error) {
        // Still frees the slot: a stopped task's agent no longer counts against the limit.
        finish(task, "stopped", `Stop failed (${error instanceof Error ? error.message : String(error)}); slot freed after ${minutes} min with no file changes${note}`);
      }
    }
    if (pruneHistory(tasks(), at)) changed();
  }

  /** After a restart: tasks left "starting" are matched to their agent, never sent again. */
  async function recover(paseo: PaseoApi): Promise<void> {
    for (const task of tasks()) {
      if (task.state === "starting") {
        const found = await findAgentFor(paseo, task).catch(() => null);
        if (found) {
          task.agentId = found.agentId;
          task.workspaceId = found.workspaceId;
          task.state = "running";
          task.lastChangeAt = now();
          log.info(FEATURE, `Recovered task after restart: ${task.title}`, { taskId: task.id, agentId: found.agentId });
          changed();
        } else {
          finish(task, "failed", "Interrupted while starting (Mission Control restarted). No agent was found; Retry to run it.");
        }
      } else if (task.state === "running" && !task.agentId) {
        const found = await findAgentFor(paseo, task).catch(() => null);
        if (found) {
          task.agentId = found.agentId;
          changed();
        }
      }
    }
  }

  /**
   * The live task an agent belongs to, by id or by its metadata. The metadata match covers the
   * moment between Paseo creating the agent and `workspaces.create` returning.
   */
  function runningTaskOf(agent: { id: string; metadata?: Record<string, unknown> }): QueueTask | undefined {
    const byId = tasks().find((candidate) => candidate.agentId === agent.id && (candidate.state === "running" || candidate.state === "starting"));
    if (byId) return byId;
    const taskId = agent.metadata?.[TASK_METADATA_KEY];
    if (typeof taskId !== "string") return undefined;
    const task = tasks().find((candidate) => candidate.id === taskId && (candidate.state === "running" || candidate.state === "starting"));
    if (task && !task.agentId) {
      task.agentId = agent.id;
      changed();
    }
    return task;
  }

  // Hooks: a task's run ends with its agent's turn; an archived agent ends it too.
  const removers = [
    adapter.addHook("agent.create.after", FEATURE, async ({ agent }) => {
      runningTaskOf(agent);
    }),
    adapter.addHook("agent.turn.after", FEATURE, async ({ agent, outcome }) => {
      const task = runningTaskOf(agent);
      if (!task || task.state !== "running") return;
      const minutes = minutesBetween(task.startedAt, now());
      if (outcome.kind === "completed") finish(task, "finished", `Finished after ${minutes ?? 0} min`);
      else if (outcome.kind === "failed") finish(task, "failed", `Failed after ${minutes ?? 0} min: ${outcome.error.message.split("\n")[0]?.slice(0, 160) ?? "error"}`);
      else finish(task, "stopped", `Canceled after ${minutes ?? 0} min`);
    }),
    adapter.addHook("agent.archive.after", FEATURE, async ({ agent }) => {
      const task = tasks().find((candidate) => candidate.agentId === agent.id && (candidate.state === "running" || candidate.state === "starting"));
      if (task) finish(task, "stopped", "Agent archived before it finished");
    }),
  ];
  const offRegistry = registry.onChange(scheduleDispatch);

  function find(taskId: string): QueueTask | undefined {
    return tasks().find((task) => task.id === taskId);
  }

  return {
    start(paseo) {
      if (api) return;
      api = paseo;
      void recover(paseo)
        .catch((error: unknown) => log.error(FEATURE, "Recovery after restart failed", error))
        .finally(() => {
          void dispatch();
          void catalog.read(paseo).then(() => changed()).catch(() => undefined);
        });
      tickTimer = setInterval(() => void dispatch(), TICK_MS);
      tickTimer.unref?.();
      changeTimer = setInterval(() => void checkRunning().catch((error: unknown) => log.error(FEATURE, "Running-task check failed", error)), CHANGE_CHECK_MS);
      changeTimer.unref?.();
      log.info(FEATURE, "Dispatcher running", { queued: tasks().filter((task) => task.state === "queued").length, slotLimit: settings().slotLimit });
    },

    snapshot(hostLabel) {
      const at = now();
      const cached = catalog.cached();
      const current = settings();
      return {
        generatedAt: at,
        hostLabel,
        dispatcherReady: api !== null,
        slotLimit: current.slotLimit,
        unattendedStopMinutes: current.unattendedStopMinutes,
        holders: holders(),
        tasks: orderForDisplay(tasks(), at),
        projects: cached.projects.map((project) => ({ key: project.id, label: project.name, detail: project.path })),
        profiles: cached.profiles,
        catalogError: cached.error,
      };
    },

    queuedCount: () => tasks().filter((task) => task.state === "queued").length,
    task: find,
    taskForAgent: (agentId) => tasks().find((task) => task.agentId === agentId),

    async add(paseo, input) {
      await catalog.read(paseo);
      let project = catalog.project(input.projectKey);
      if (!project) {
        await catalog.read(paseo, true);
        project = catalog.project(input.projectKey);
      }
      if (!project) return { ok: false, message: "That project is no longer on this host." };
      const profile = catalog.cached().profiles.find((choice) => choice.key === input.profileKey);
      if (!profile) return { ok: false, message: "That agent profile is no longer on this host." };
      const task: QueueTask = {
        id: randomUUID(),
        title: input.title?.trim() || titleFromPrompt(input.prompt),
        prompt: input.prompt.trim(),
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        baseRef: input.baseRef?.trim() || null,
        profileKey: profile.key,
        profileLabel: profile.label,
        state: "queued",
        createdAt: now(),
        attempt: 1,
        startedAt: null,
        finishedAt: null,
        startedBy: null,
        overLimit: false,
        agentId: null,
        workspaceId: null,
        lastChangeAt: null,
        outcome: null,
      };
      tasks().push(task);
      log.info(FEATURE, `Queued: ${task.title}`, { taskId: task.id, project: project.name, profile: profile.label });
      changed();
      const position = tasks().filter((candidate) => candidate.state === "queued").length;
      const startsNow = api !== null && position === 1 && freeSlots(settings().slotLimit, holders()) > 0;
      void dispatch();
      return { ok: true, message: startsNow ? "Queued. Starting now." : `Queued, position ${position}.` };
    },

    remove(taskId) {
      const task = find(taskId);
      if (!task) return { ok: false, message: "That task no longer exists." };
      if (task.state === "starting" || task.state === "running") {
        return { ok: false, message: "It is running. Archive or stop its agent in Paseo instead." };
      }
      store.state.queue = tasks().filter((candidate) => candidate.id !== taskId);
      changed();
      return { ok: true, message: task.state === "queued" ? "Removed from the queue." : "Cleared." };
    },

    moveUp(taskId) {
      const moved = moveUp(tasks(), taskId);
      if (moved) changed();
      return moved ? { ok: true, message: "Moved up." } : { ok: false, message: "It is already first." };
    },

    async startNow(paseo, taskId) {
      const task = find(taskId);
      if (!task || task.state !== "queued") return { ok: false, message: "Only a queued task can be started." };
      const limit = settings().slotLimit;
      const used = holders().length;
      const overLimit = used >= limit;
      await launch(paseo, task, "user", overLimit);
      if ((task as QueueTask).state === "failed") return { ok: false, message: task.outcome ?? "Could not start." };
      return { ok: true, message: overLimit ? `Started over the slot limit (${used + 1} of ${limit}).` : "Started." };
    },

    retry(taskId) {
      const task = find(taskId);
      if (!task || (task.state !== "failed" && task.state !== "stopped")) return { ok: false, message: "Only a failed or stopped task can be retried." };
      // Back to the end of the queue as a fresh attempt; the old agent and worktree stay as they are.
      store.state.queue = tasks().filter((candidate) => candidate.id !== taskId);
      tasks().push({
        ...task,
        state: "queued",
        attempt: task.attempt + 1,
        startedAt: null,
        finishedAt: null,
        startedBy: null,
        overLimit: false,
        agentId: null,
        workspaceId: null,
        lastChangeAt: null,
        outcome: null,
        id: randomUUID(),
      });
      changed();
      void dispatch();
      return { ok: true, message: "Queued again at the end." };
    },

    async refreshCatalog(paseo) {
      await catalog.read(paseo, true);
      changed();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    stop() {
      stopped = true;
      if (tickTimer) clearInterval(tickTimer);
      if (changeTimer) clearInterval(changeTimer);
      if (debounce) clearTimeout(debounce);
      offRegistry();
      for (const remove of removers) remove();
    },
  };
}
