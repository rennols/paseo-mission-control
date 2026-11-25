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
