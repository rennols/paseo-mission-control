/**
 * Contracts for the Queue and Review inbox tabs. Plain Zod values only: this module is imported by
 * both the daemon and the app. Both lists are per host: a plugin can't call RPCs on its copy on
 * another host (step 0, finding 8).
 */
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { AgentStatusSchema } from "./live";

// ---------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------

export const TaskStateSchema = z.enum(["queued", "starting", "running", "finished", "failed", "stopped"]);
export type TaskState = z.output<typeof TaskStateSchema>;

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

export const QueueTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string(),
  /** The project's main checkout. The task's worktree branches off it. */
  projectPath: z.string(),
  /** Branch or ref to branch off. Null: the checkout's current branch. */
  baseRef: z.string().nullable(),
  /** Saved agent profile id, or `provider:<id>` for a provider's defaults. */
  profileKey: z.string(),
  profileLabel: z.string(),
  state: TaskStateSchema,
  createdAt: z.number(),
  /** Bumped on Retry, so the creation idempotency key is new for each attempt. */
  attempt: z.number().int().default(1),
  startedAt: z.number().nullable().default(null),
  finishedAt: z.number().nullable().default(null),
  startedBy: z.enum(["queue", "user"]).nullable().default(null),
  /** Start now was used while every slot was taken. */
  overLimit: z.boolean().default(false),
  agentId: z.string().nullable().default(null),
  workspaceId: z.string().nullable().default(null),
  /** Last time the agent's worktree changed (unattended rule). */
  lastChangeAt: z.number().nullable().default(null),
  /** One line on what happened, e.g. "Stopped after 60 min with no file changes". */
  outcome: z.string().nullable().default(null),
});
export type QueueTask = z.output<typeof QueueTaskSchema>;

export const SlotHolderSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  status: AgentStatusSchema,
  /** Set when a queue task started this agent. */
  taskId: z.string().nullable(),
});
export type SlotHolder = z.output<typeof SlotHolderSchema>;

export const ChoiceSchema = z.object({ key: z.string(), label: z.string(), detail: z.string().nullable() });
export type Choice = z.output<typeof ChoiceSchema>;

export const QueueSnapshotSchema = z.object({
  generatedAt: z.number(),
  hostLabel: z.string(),
  /** False until Mission Control has the Paseo SDK (after a daemon restart: until an agent event or a screen open). */
  dispatcherReady: z.boolean(),
  slotLimit: z.number(),
  unattendedStopMinutes: z.number(),
  holders: z.array(SlotHolderSchema),
  /** Queued first (in order), then starting and running, then the last 24 h of finished, failed and stopped. */
  tasks: z.array(QueueTaskSchema),
  /** For the Add task form. Projects are git projects Paseo knows on this host. */
  projects: z.array(ChoiceSchema),
  profiles: z.array(ChoiceSchema),
  /** Why projects or profiles could not be read, if they couldn't. */
  catalogError: z.string().nullable(),
});
export type QueueSnapshot = z.output<typeof QueueSnapshotSchema>;

/** Streams the queue. The first event arrives at once; later ones on change. */
export const queueWatch = defineSubscription({
  name: "queue.watch",
  input: z.object({}),
  event: QueueSnapshotSchema,
});

const ActionResult = z.object({ ok: z.boolean(), message: z.string() });

export const addTask = defineRpc({
  name: "queue.task.add",
  input: z.object({
    prompt: z.string().trim().min(1).max(20_000),
    title: z.string().trim().max(120).optional(),
    projectKey: z.string().min(1),
    profileKey: z.string().min(1),
    baseRef: z.string().trim().max(200).optional(),
  }),
  output: ActionResult,
});

/** Removes a queued task, or clears a finished, failed or stopped one from the list. */
export const removeTask = defineRpc({
  name: "queue.task.remove",
  input: z.object({ taskId: z.string() }),
  output: ActionResult,
});

export const moveTaskUp = defineRpc({
  name: "queue.task.up",
  input: z.object({ taskId: z.string() }),
  output: ActionResult,
});

/** Starts a queued task now, even when every slot is taken (the result says so). */
export const startTaskNow = defineRpc({
  name: "queue.task.start",
  input: z.object({ taskId: z.string() }),
  output: ActionResult,
});

/** Puts a failed or stopped task back at the end of the queue. */
export const retryTask = defineRpc({
  name: "queue.task.retry",
  input: z.object({ taskId: z.string() }),
  output: ActionResult,
});

// ---------------------------------------------------------------------------------------------
// Review inbox
// ---------------------------------------------------------------------------------------------

export const ChangedFileSchema = z.object({
  path: z.string(),
  /** Null for binary files. */
  added: z.number().nullable(),
  removed: z.number().nullable(),
  untracked: z.boolean(),
});
export type ChangedFile = z.output<typeof ChangedFileSchema>;

export const InboxItemSchema = z.object({
  /** The agent id: one item per agent. */
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  provider: z.string(),
  workspaceName: z.string(),
  branch: z.string().nullable(),
  /** What the PR targets, e.g. "main". */
  baseBranch: z.string().nullable(),
  cwd: z.string(),
  finishedAt: z.number(),
  taskId: z.string().nullable(),
  /** The agent's final message for its last turn, trimmed. */
  summary: z.string().nullable(),
  /** Failed checks the agent ran in its last turn, e.g. "npm test: adds numbers". From its latest turn summary card. */
  failedChecks: z.array(z.string()),
  files: z.array(ChangedFileSchema),
  linesAdded: z.number(),
  linesRemoved: z.number(),
  uncommitted: z.boolean(),
  commitsAhead: z.number(),
  diffExcerpt: z.string(),
  diffTruncated: z.boolean(),
  state: z.enum(["open", "pr_opened", "sent_back"]),
  prUrl: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  resolution: z.string().nullable(),
});
export type InboxItem = z.output<typeof InboxItemSchema>;

export const InboxSnapshotSchema = z.object({
  generatedAt: z.number(),
  hostLabel: z.string(),
  /** Open items oldest first, then items resolved in the last 24 h. */
  items: z.array(InboxItemSchema),
});
export type InboxSnapshot = z.output<typeof InboxSnapshotSchema>;

export const inboxWatch = defineSubscription({
  name: "inbox.watch",
  input: z.object({}),
  event: InboxSnapshotSchema,
});

/**
 * Commits what is uncommitted, pushes the branch and runs `gh pr create`. Only from a click.
 * `title` is the commit message and the PR title.
 */
export const commitAndOpenPr = defineRpc({
  name: "inbox.pr.open",
  input: z.object({ itemId: z.string(), title: z.string().trim().min(1).max(200) }),
  output: z.object({ ok: z.boolean(), message: z.string(), prUrl: z.string().nullable() }),
});

/** Sends the note to the agent as its next prompt and removes the item. */
export const sendBack = defineRpc({
  name: "inbox.send_back",
  input: z.object({ itemId: z.string(), note: z.string().trim().min(1).max(4000) }),
  output: ActionResult,
});

/** Counts for the tab labels: open review items and queued tasks. */
export const workCountWatch = defineSubscription({
  name: "work.count.watch",
  input: z.object({}),
  event: z.object({ queued: z.number().int().nonnegative(), review: z.number().int().nonnegative() }),
});
