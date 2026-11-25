import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Watchdog thresholds, one document per host (PRD: Sidebar and settings). Stored by Paseo under
 * `$PASEO_HOME/plugin-settings/mission-control/`, which `paseo plugin remove` deletes.
 */
export const watchdogSettings = defineSettings({
  id: "watchdog",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Same error this many turns in a row raises Stuck. */
    sameErrorTurns: z.number().int().min(2).max(20).default(3),
    /** This many user turns in a row with no file changes raises Stuck. */
    idleTurns: z.number().int().min(2).max(50).default(5),
    /** A run longer than this raises Over time. */
    timeLimitMinutes: z.number().int().min(5).max(24 * 60).default(45),
  }),
});

export type WatchdogSettings = z.output<typeof watchdogSettings.schema>;

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettings = watchdogSettings.schema.parse({});

/** Minutes added by the "Allow 30 more min" action on an Over time card. */
export const EXTEND_MINUTES = 30;

/** "HH:MM", 24-hour clock. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Task queue limits and the overnight window, one document per host (PRD: Settings). The window
 * is in the host's local time and feeds the overnight report (P2).
 */
export const queueSettings = defineSettings({
  id: "queue",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Agents that may hold a slot at once on this host: working, waiting on you or stuck. */
    slotLimit: z.number().int().min(1).max(20).default(3),
    /** A queue-started agent that changes no files for this long is interrupted to free its slot. */
    unattendedStopMinutes: z.number().int().min(15).max(24 * 60).default(60),
    /** Overnight window for the report. Added after version 1 shipped; old documents read the defaults. */
    overnightStart: z.string().regex(CLOCK_TIME).default("22:00"),
    overnightEnd: z.string().regex(CLOCK_TIME).default("07:00"),
  }),
});

export type QueueSettings = z.output<typeof queueSettings.schema>;

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = queueSettings.schema.parse({});
