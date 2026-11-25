/**
 * Contracts for the Live tab, the Needs you list and the sidebar footer entry. Plain Zod values
 * only: this module is imported by both the daemon and the app.
 */
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** PRD statuses. Ready for review and Paused arrive with the review inbox and Pause (P1, open). */
export const AgentStatusSchema = z.enum(["working", "waiting", "stuck", "idle", "error", "closed"]);
export type AgentStatus = z.output<typeof AgentStatusSchema>;

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  waiting: "Waiting on you",
  stuck: "Stuck",
  idle: "Idle",
  error: "Error",
  closed: "Closed",
};

/** One stretch of the 30-minute activity lane. Times are epoch milliseconds. */
export const LaneSegmentSchema = z.object({
  kind: z.enum(["working", "idle", "waiting", "stuck"]),
  from: z.number(),
  to: z.number(),
});
export type LaneSegment = z.output<typeof LaneSegmentSchema>;

export const LaneMarkSchema = z.object({
  kind: z.enum(["repeat", "finished"]),
  at: z.number(),
});
export type LaneMark = z.output<typeof LaneMarkSchema>;

export const AgentRowSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  hostLabel: z.string(),
  title: z.string(),
  provider: z.string(),
  workspaceKey: z.string(),
  workspaceName: z.string(),
  branch: z.string().nullable(),
  parentAgentId: z.string().nullable(),
  status: AgentStatusSchema,
  /** When the current run started (working), else when the agent was created. */
  since: z.number(),
  linesAdded: z.number().nullable(),
  linesRemoved: z.number().nullable(),
  latestActivity: z.string().nullable(),
  lane: z.array(LaneSegmentSchema),
  marks: z.array(LaneMarkSchema),
  /** The lane in words, for screen readers. */
  laneDescription: z.string(),
  /** False for agents read from another host: hooks, the watchdog and Needs you don't cover them. */
  watched: z.boolean(),
});
export type AgentRow = z.output<typeof AgentRowSchema>;

export const NeedsKindSchema = z.enum(["stuck", "permission", "question", "overtime"]);
export type NeedsKind = z.output<typeof NeedsKindSchema>;

export const NeedsOptionSchema = z.object({ label: z.string(), description: z.string().optional() });

export const NeedsItemSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string(),
  kind: NeedsKindSchema,
  /** Permission: the request title. Stuck: the reason. Question: the question text. */
  title: z.string(),
  detail: z.string().nullable(),
  /** Permission requests grouped on this card (orchestrators raise several in a row). */
  requests: z.array(z.object({ requestId: z.string(), title: z.string(), detail: z.string().nullable() })),
  /** Tool questions: the options the agent offered. */
  options: z.array(NeedsOptionSchema),
  questionSource: z.enum(["tool", "text"]).nullable(),
  openedAt: z.number(),
  resolvedAt: z.number().nullable(),
  /** One line saying what happened, shown when the card collapses. */
  resolution: z.string().nullable(),
});
export type NeedsItem = z.output<typeof NeedsItemSchema>;

export const HostSummarySchema = z.object({
  serverId: z.string(),
  label: z.string(),
  self: z.boolean(),
  status: z.string(),
  error: z.string().nullable(),
});
export type LiveHost = z.output<typeof HostSummarySchema>;

export const LiveSnapshotSchema = z.object({
  generatedAt: z.number(),
  self: z.object({ serverId: z.string(), label: z.string() }),
  hosts: z.array(HostSummarySchema),
  agents: z.array(AgentRowSchema),
  /** Open items first (most urgent first), then items resolved in the last 10 minutes. */
  needs: z.array(NeedsItemSchema),
});
export type LiveSnapshot = z.output<typeof LiveSnapshotSchema>;

/** Streams the whole Live snapshot. The first event arrives at once; later ones on change. */
export const liveWatch = defineSubscription({
  name: "live.watch",
  input: z.object({}),
  event: LiveSnapshotSchema,
});

/** Streams the open Needs you count for the sidebar footer entry. */
export const needsCountWatch = defineSubscription({
  name: "needs.count.watch",
  input: z.object({}),
  event: z.object({ open: z.number().int().nonnegative() }),
});

const ActionResult = z.object({ ok: z.boolean(), message: z.string() });
export type ActionResult = z.output<typeof ActionResult>;

/** Allow once or Deny one pending permission request. Always a user click. */
export const respondPermission = defineRpc({
  name: "needs.permission.respond",
  input: z.object({ itemId: z.string(), requestId: z.string(), decision: z.enum(["allow", "deny"]) }),
  output: ActionResult,
});

/** Send a hint: the text becomes the agent's next prompt. */
export const sendHint = defineRpc({
  name: "needs.hint.send",
  input: z.object({ itemId: z.string(), text: z.string().trim().min(1).max(4000) }),
  output: ActionResult,
});

/** Dismiss a card the user thinks is wrong. Counted for the false-flag metric. */
export const dismissNeed = defineRpc({
  name: "needs.dismiss",
  input: z.object({ itemId: z.string() }),
  output: ActionResult,
});

/** Over time: allow 30 more minutes. */
export const extendTime = defineRpc({
  name: "needs.overtime.extend",
  input: z.object({ itemId: z.string() }),
  output: ActionResult,
});
