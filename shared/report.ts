/**
 * Contract for the overnight report (PRD: Overnight report, P2): a card on the Queue tab that lists
 * what ran from the queue in the overnight window, what each run changed and what it needs from
 * you. Plain Zod values only: this module is imported by both the daemon and the app.
 *
 * Everything in it comes from data Mission Control already has: queue tasks, Review inbox items,
 * Needs you cards and turn summaries. Building it runs no commands.
 */
import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { SummaryCheckSchema } from "./chat";
import { TaskStateSchema } from "./queue";

export const ReportNeedSchema = z.object({
  kind: z.enum(["permission", "question", "stuck", "overtime", "review", "retry"]),
  /** One line, e.g. "Review 4 changed files", "Approve: Bash touch stall-marker.txt". */
  label: z.string(),
});
export type ReportNeed = z.output<typeof ReportNeedSchema>;

export const ReportRunSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  projectName: z.string(),
  state: TaskStateSchema,
  startedBy: z.enum(["queue", "user"]).nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  /** The queue's one line on what happened, e.g. "Stopped by the watchdog after 60 min with no file changes". */
  outcome: z.string().nullable(),
  agentId: z.string().nullable(),
  /**
   * What changed. "review": the branch against its base, from the Review inbox item. "turns": the
   * run's turn summary cards. Null when neither exists (for example the run never started).
   */
  changes: z
    .object({
      source: z.enum(["review", "turns"]),
      files: z.number().int().nonnegative(),
      linesAdded: z.number().int().nonnegative(),
      linesRemoved: z.number().int().nonnegative(),
      /** Up to 3 paths, for the one-line preview. */
      sample: z.array(z.string()),
    })
    .nullable(),
  /** The last result of each check the agent ran itself during the run (from its turn summaries). */
  checks: z.array(SummaryCheckSchema),
  /** The run's Review inbox item: open, or what you did with it (in the last 24 h). */
  review: z
    .object({
      itemId: z.string(),
      state: z.enum(["open", "pr_opened", "sent_back"]),
      prUrl: z.string().nullable(),
    })
    .nullable(),
  /** What it needs from you, most urgent first. Empty: nothing. */
  needs: z.array(ReportNeedSchema),
});
export type ReportRun = z.output<typeof ReportRunSchema>;

export const OvernightReportSchema = z.object({
  generatedAt: z.number(),
  hostLabel: z.string(),
  window: z.object({
    /** "HH:MM" in the host's local time, as set in Settings, Queue. */
    start: z.string(),
    end: z.string(),
    from: z.number(),
    to: z.number(),
    /** True while the window is still open (the report so far). */
    inProgress: z.boolean(),
  }),
  counts: z.object({
    runs: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    stopped: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    /** Runs whose work is waiting in the Review inbox. */
    review: z.number().int().nonnegative(),
    /** Runs that need something from you (any of `needs`). */
    needsYou: z.number().int().nonnegative(),
    /** Tasks still queued when the report was built. */
    stillQueued: z.number().int().nonnegative(),
  }),
  /** Runs that need you first, then the rest, each group in start order. */
  runs: z.array(ReportRunSchema),
});
export type OvernightReport = z.output<typeof OvernightReportSchema>;

/** Streams the report for this host. The first event arrives at once; later ones on change. */
export const overnightReportWatch = defineSubscription({
  name: "report.overnight.watch",
  input: z.object({}),
  event: OvernightReportSchema,
});
