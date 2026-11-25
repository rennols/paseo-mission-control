/**
 * Activity lanes: each agent keeps a short list of status changes, and the lane for the last 30
 * minutes is cut from it when a snapshot is built. Pure functions, unit-tested.
 */
import type { AgentStatus, LaneMark, LaneSegment } from "../../shared/live";

export const LANE_WINDOW_MS = 30 * 60_000;

export type LaneKind = LaneSegment["kind"];

export interface Transition {
  kind: LaneKind;
  at: number;
}

export function laneKind(status: AgentStatus): LaneKind {
  switch (status) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "stuck":
      return "stuck";
    default:
      return "idle";
  }
}

/** Appends a transition when the kind changes, and drops history older than the window. */
export function recordTransition(transitions: Transition[], kind: LaneKind, at: number, windowMs = LANE_WINDOW_MS): Transition[] {
  const last = transitions[transitions.length - 1];
  const next = last?.kind === kind ? transitions : [...transitions, { kind, at }];
  // Keep the newest transition that started before the window: it covers the window's left edge.
  const start = at - windowMs;
  let firstInside = next.findIndex((transition) => transition.at >= start);
  if (firstInside === -1) firstInside = next.length;
  return next.slice(Math.max(0, firstInside - 1));
}

/** Segments clipped to [now - window, now]. Adjacent segments of one kind are merged. */
export function buildLane(transitions: readonly Transition[], now: number, windowMs = LANE_WINDOW_MS): LaneSegment[] {
  const start = now - windowMs;
  const segments: LaneSegment[] = [];
  transitions.forEach((transition, index) => {
    const from = Math.max(transition.at, start);
    const to = Math.min(transitions[index + 1]?.at ?? now, now);
    if (to <= from) return;
    const previous = segments[segments.length - 1];
    if (previous && previous.kind === transition.kind && previous.to === from) previous.to = to;
    else segments.push({ kind: transition.kind, from, to });
  });
  return segments;
}

export function marksInWindow(marks: readonly LaneMark[], now: number, windowMs = LANE_WINDOW_MS): LaneMark[] {
  return marks.filter((mark) => mark.at >= now - windowMs && mark.at <= now);
}

/** Plain-text lane for screen readers: "Last 30 min: working 12 min, idle 18 min. 2 repeats." */
export function describeLane(segments: readonly LaneSegment[], marks: readonly LaneMark[]): string {
  if (segments.length === 0) return "No activity in the last 30 minutes.";
  const totals = new Map<LaneKind, number>();
  for (const segment of segments) totals.set(segment.kind, (totals.get(segment.kind) ?? 0) + segment.to - segment.from);
  const words: Record<LaneKind, string> = { working: "working", idle: "idle", waiting: "waiting on you", stuck: "stuck" };
  const parts = [...totals.entries()].map(([kind, ms]) => `${words[kind]} ${Math.max(1, Math.round(ms / 60_000))} min`);
  const repeats = marks.filter((mark) => mark.kind === "repeat").length;
  const finished = marks.some((mark) => mark.kind === "finished");
  return `Last 30 min: ${parts.join(", ")}.${repeats ? ` ${repeats} repeated ${repeats === 1 ? "error" : "errors"}.` : ""}${finished ? " Finished." : ""}`;
}
