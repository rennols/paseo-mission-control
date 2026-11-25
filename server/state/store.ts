/**
 * The plugin's one state file per host: `$PASEO_HOME/mission-control/state.json`. Touches files on
 * your machine: it creates that folder, writes `state.json.<pid>.tmp` beside the file and renames
 * it over `state.json`, so a crash never leaves a half-written file.
 *
 * Writes are debounced (250 ms) and serialised. A failed write is logged and retried on the next
 * change; it never throws into a feature.
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TurnSummarySchema } from "../../shared/chat";
import { NeedsItemSchema } from "../../shared/live";
import { InboxItemSchema, QueueTaskSchema } from "../../shared/queue";
import type { PluginLogger } from "../log";

const FEATURE = "state";
const WRITE_DELAY_MS = 250;

export const RadarAgentSchema = z.object({
  /** The worktree the snapshots were taken in. */
  root: z.string(),
  /** The repository's shared git directory: same value for every worktree of one repo. */
  commonDir: z.string(),
  /** Worktree tree at the start of the first turn Mission Control saw. */
  baseTree: z.string(),
  /** Worktree tree at the end of the latest turn. */
  headTree: z.string(),
  updatedAt: z.number(),
});
export type RadarAgent = z.output<typeof RadarAgentSchema>;

export const StateSchema = z.object({
  version: z.literal(1),
  needs: z.array(NeedsItemSchema).default([]),
  /** Minutes added per agent through "Allow 30 more min". */
  overtimeExtensions: z.record(z.string(), z.number()).default({}),
  /** Task queue, in queue order, plus recent finished runs (P1). */
  queue: z.array(QueueTaskSchema).default([]),
  /** Review inbox items (P1). */
  inbox: z.array(InboxItemSchema).default([]),
  /** Recent turn summaries, newest last (PRD data model: copy in state file). Feeds the review inbox later. */
  summaries: z.array(TurnSummarySchema).default([]),
  /** Collision radar (./radar): each agent's starting and latest worktree tree, and card memory. */
  radar: z
    .object({
      agents: z.record(z.string(), RadarAgentSchema).default({}),
      /** Files listed on each open collision card, by pair key. */
      shown: z.record(z.string(), z.string()).default({}),
      /** Files listed when the user dismissed a pair's card, by pair key. */
      dismissed: z.record(z.string(), z.string()).default({}),
    })
    .default({ agents: {}, shown: {}, dismissed: {} }),
  /** Local counters for the success metrics (PRD: Success metrics). */
  metrics: z
    .object({
      stuckRaised: z.number().default(0),
      stuckDismissed: z.number().default(0),
    })
    .default({ stuckRaised: 0, stuckDismissed: 0 }),
});
export type PluginState = z.output<typeof StateSchema>;

export function emptyState(): PluginState {
  return StateSchema.parse({ version: 1 });
}

export interface StateStore {
  readonly state: PluginState;
  /** Mark the state changed; it is written shortly after. */
  changed(): void;
  /** Write now and wait. Used on plugin stop. */
  flush(): Promise<void>;
}

/** Reads the file synchronously (it is small) so hooks can be registered in the entry function. */
export function openStateStore(directory: string, log: PluginLogger): StateStore {
  const file = path.join(directory, "state.json");
  const temp = path.join(directory, `state.json.${process.pid}.tmp`);
  let state = emptyState();

  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const parsed = StateSchema.safeParse(raw);
    if (parsed.success) state = parsed.data;
    else log.warn(FEATURE, `Ignoring unreadable ${file}; starting empty`, parsed.error.issues.slice(0, 3));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.error(FEATURE, `Could not read ${file}`, error);
  }

  let timer: NodeJS.Timeout | null = null;
  let writing: Promise<void> = Promise.resolve();
  let dirty = false;

  async function write(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    const text = `${JSON.stringify(state, null, 2)}\n`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temp, text, "utf8");
      await rename(temp, file);
    } catch (error) {
      dirty = true;
      log.error(FEATURE, `Could not write ${file}`, error);
    }
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      writing = writing.then(write);
    }, WRITE_DELAY_MS);
  }

  return {
    get state() {
      return state;
    },
    changed() {
      dirty = true;
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      writing = writing.then(write);
      await writing;
    },
  };
}
