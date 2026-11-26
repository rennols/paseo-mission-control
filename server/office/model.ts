/**
 * Office tab: what each agent on this host is doing right now, and the in-agent subagents it has
 * handed work to. Built from the agent's live timeline events, one at a time. Pure functions,
 * unit-tested; the SDK wiring is in ./activity.ts.
 */
import type { Helper, NowKind } from "../../shared/live";

/** Finished helpers stay on their desk this long, then leave. */
export const HELPER_KEEP_MS = 10 * 60_000;
/** At most this many helpers per agent. The oldest finished ones leave first. */
export const MAX_HELPERS = 8;

export interface Activity {
  now: string | null;
  nowKind: NowKind | null;
  nowAt: number | null;
  /** By tool call id. */
  helpers: Map<string, Helper>;
}

export function emptyActivity(): Activity {
  return { now: null, nowKind: null, nowAt: null, helpers: new Map() };
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Claude reports in-agent subagents as `sub_agent` details; older paths as a bare "Task" call. */
export function isHelperCall(item: Rec): boolean {
  if (item.type !== "tool_call") return false;
  const detail = rec(item.detail);
  if (detail?.type === "sub_agent") return true;
  const name = str(item.name)?.toLowerCase();
  return detail?.type === "unknown" && (name === "task" || name === "agent");
}

/** One line for a tool call: "Editing dispatch.ts", "Running npm test". */
export function describeNow(item: Rec): { text: string; kind: NowKind } | null {
  if (item.type === "reasoning") return { text: "Thinking", kind: "think" };
  if (item.type === "assistant_message") return { text: "Writing a reply", kind: "write" };
  if (item.type !== "tool_call") return null;
  const detail = rec(item.detail);
  const running = item.status === "running";
  const verb = (doing: string, done: string) => (running ? doing : done);
  switch (detail?.type) {
    case "shell": {
      const command = str(detail.command);
      return command ? { text: cut(`${verb("Running", "Ran")} ${command}`, 90), kind: "run" } : null;
    }
    case "read": {
      const file = str(detail.filePath);
      return file ? { text: `${verb("Reading", "Read")} ${baseName(file)}`, kind: "read" } : null;
    }
    case "edit":
    case "write": {
      const file = str(detail.filePath);
      return file ? { text: `${verb("Editing", "Edited")} ${baseName(file)}`, kind: "edit" } : null;
    }
    case "search": {
      const query = str(detail.query);
      return query ? { text: cut(`${verb("Searching", "Searched")} ${query}`, 90), kind: "search" } : null;
    }
    case "fetch": {
      const url = str(detail.url);
      return url ? { text: cut(`${verb("Fetching", "Fetched")} ${url.replace(/^https?:\/\//, "")}`, 90), kind: "fetch" } : null;
    }
    case "sub_agent":
      return { text: cut(`Handed off: ${str(detail.description) ?? str(detail.subAgentType) ?? "a task"}`, 90), kind: "delegate" };
    case "plan":
      return { text: "Writing a plan", kind: "write" };
    default: {
      if (isHelperCall(item)) return { text: "Handed off a task", kind: "delegate" };
      const name = str(item.name);
      return name ? { text: cut(`${verb("Using", "Used")} ${name}`, 90), kind: "other" } : null;
    }
  }
}

/** The helper's latest action: the last entry of `actions`, else the provider's activity note. */
function lastAction(item: Rec, detail: Rec | null): string | null {
  const actions = Array.isArray(detail?.actions) ? detail.actions.map(rec).filter((a): a is Rec => a !== null) : [];
  const last = actions[actions.length - 1];
  if (last) {
    const tool = str(last.toolName);
    const summary = str(last.summary);
    const text = [tool, summary ? (summary.includes("/") || summary.includes("\\") ? baseName(summary) : summary) : null].filter(Boolean).join(" ");
    if (text) return cut(text, 80);
  }
  const note = str(rec(item.metadata)?.subAgentActivity);
  return note ? cut(note, 80) : null;
}

function helperStatus(status: unknown): Helper["status"] {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "canceled" || status === "cancelled") return "stopped";
  return "working";
}

function prune(helpers: Map<string, Helper>, at: number): void {
  for (const [id, helper] of helpers) {
    if (helper.endedAt !== null && at - helper.endedAt > HELPER_KEEP_MS) helpers.delete(id);
  }
  if (helpers.size <= MAX_HELPERS) return;
  const finished = [...helpers.values()].filter((h) => h.endedAt !== null).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  for (const helper of finished) {
    if (helpers.size <= MAX_HELPERS) break;
    helpers.delete(helper.id);
  }
}

/**
 * Applies one timeline item. Returns true when anything the Office tab shows changed.
 * Tool calls arrive more than once (running, then completed); the call id ties them together.
 */
export function applyItem(activity: Activity, value: unknown, at: number): boolean {
  const item = rec(value);
  if (!item) return false;
  let changed = false;
  const helperCall = isHelperCall(item);
  let newHelper = false;

  if (helperCall) {
    const detail = rec(item.detail);
    const id = str(item.callId) ?? `helper-${at}`;
    const previous = activity.helpers.get(id);
    const status = helperStatus(item.status);
    const next: Helper = {
      id,
      type: str(detail?.subAgentType) ?? previous?.type ?? "Task",
      ask: str(detail?.description) ?? previous?.ask ?? null,
      status,
      lastAction: lastAction(item, detail) ?? previous?.lastAction ?? null,
      startedAt: previous?.startedAt ?? at,
      endedAt: status === "working" ? null : (previous?.endedAt ?? at),
    };
    newHelper = previous === undefined;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      activity.helpers.set(id, next);
      changed = true;
    }
  }

  // A helper's later progress updates show on its own desk, not on the parent's now line.
  const now = helperCall && !newHelper ? null : describeNow(item);
  if (now && (now.text !== activity.now || now.kind !== activity.nowKind)) {
    activity.now = now.text;
    activity.nowKind = now.kind;
    activity.nowAt = at;
    changed = true;
  }
  prune(activity.helpers, at);
  return changed;
}

/** The turn ended: clear the now line, and close helpers the provider never reported as finished. */
export function endTurn(activity: Activity, at: number, outcome: "completed" | "failed" | "canceled"): boolean {
  let changed = activity.now !== null;
  activity.now = null;
  activity.nowKind = null;
  activity.nowAt = null;
  for (const [id, helper] of activity.helpers) {
    if (helper.endedAt !== null) continue;
    activity.helpers.set(id, { ...helper, status: outcome === "completed" ? "done" : outcome === "failed" ? "failed" : "stopped", endedAt: at });
    changed = true;
  }
  prune(activity.helpers, at);
  return changed;
}

/** Helpers newest first, after dropping the ones past their keep time. */
export function helpersOf(activity: Activity, at: number): Helper[] {
  prune(activity.helpers, at);
  return [...activity.helpers.values()].sort((a, b) => b.startedAt - a.startedAt);
}
