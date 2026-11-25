/**
 * The watchdog's counting rules, as pure functions over per-agent counters. The watchdog only
 * flags: nothing here pauses, stops or answers anything.
 *
 * - Same error: a failure signature seen in this many consecutive counted turns.
 * - No file changes: this many consecutive user-started turns with no file changes.
 * - Over time: a run longer than the time limit (checked by the 60 s timer, see overtime()).
 *
 * Turns Paseo starts on its own (no user message, e.g. a parent woken when its worker finishes)
 * don't advance or reset the no-changes count. Canceled turns are ignored entirely.
 */
import type { WatchdogSettings } from "../../shared/settings";
import type { TurnFacts } from "./turn";

export interface AgentCounters {
  /** Consecutive-turn count per failure signature. Signatures absent from a turn drop out. */
  repeats: Record<string, { count: number; display: string }>;
  /** Consecutive user-started turns with no file changes. */
  turnsWithoutChanges: number;
}

export const EMPTY_COUNTERS: AgentCounters = { repeats: {}, turnsWithoutChanges: 0 };

export type Trip =
  | { reason: "same-error"; signature: string; display: string; turns: number }
  | { reason: "no-changes"; turns: number };

export interface TurnVerdict {
  counters: AgentCounters;
  /** Thresholds reached by this turn. Empty when the agent looks fine. */
  trips: Trip[];
  /** Signatures that repeated in this turn (count >= 2): drawn as ticks on the lane. */
  repeated: string[];
  /** False when the turn was skipped (Paseo-started, nothing failed, nothing changed). */
  counted: boolean;
}

export function applyTurn(
  previous: AgentCounters,
  facts: Pick<TurnFacts, "userStarted" | "failures">,
  changedFiles: boolean,
  settings: WatchdogSettings,
): TurnVerdict {
  // A turn Paseo started on its own with no failures says nothing about a loop: leave counts as they are.
  if (!facts.userStarted && facts.failures.length === 0 && !changedFiles) {
    return { counters: previous, trips: [], repeated: [], counted: false };
  }
  const repeats: AgentCounters["repeats"] = {};
  const repeated: string[] = [];
  for (const failure of facts.failures) {
    const count = (previous.repeats[failure.signature]?.count ?? 0) + 1;
    repeats[failure.signature] = { count, display: failure.display };
    if (count >= 2) repeated.push(failure.signature);
  }

  let turnsWithoutChanges = previous.turnsWithoutChanges;
  if (changedFiles) turnsWithoutChanges = 0;
  else if (facts.userStarted) turnsWithoutChanges += 1;

  const trips: Trip[] = [];
  let worst: { signature: string; display: string; count: number } | null = null;
  for (const [signature, { count, display }] of Object.entries(repeats)) {
    if (count >= settings.sameErrorTurns && (!worst || count > worst.count)) worst = { signature, display, count };
  }
  if (worst) trips.push({ reason: "same-error", signature: worst.signature, display: worst.display, turns: worst.count });
  if (turnsWithoutChanges >= settings.idleTurns) trips.push({ reason: "no-changes", turns: turnsWithoutChanges });

  return { counters: { repeats, turnsWithoutChanges }, trips, repeated, counted: true };
}

/** True when a run that started at `runStartedAt` is past its limit plus any extensions. */
export function isOverTime(
  runStartedAt: number,
  now: number,
  settings: WatchdogSettings,
  extraMinutes: number,
): boolean {
  return now - runStartedAt > (settings.timeLimitMinutes + extraMinutes) * 60_000;
}

export function describeTrip(trip: Trip): string {
  if (trip.reason === "same-error") return `Same error ${trip.turns} turns in a row`;
  return `No file changes for ${trip.turns} turns`;
}
