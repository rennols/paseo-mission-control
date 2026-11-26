/**
 * Office tab model: rooms, supervisors and desks, built from the Live snapshot. Pure, so it can be
 * unit-tested without React Native.
 *
 * A room is a top-level agent (the supervisor). Its desks are the agents it started through Paseo
 * (rows with a parentAgentId, at any depth) and the in-agent subagents the provider runs inside it
 * (Claude's Task tool), which the server reads from the live timeline.
 */
import type { AgentRow, AgentStatus, Helper } from "../shared/live";

export type DeskState = "working" | "waiting" | "stuck" | "idle" | "done" | "error" | "stopped" | "closed";

/** Icon, word and pose for each state, so colour is never the only signal. */
export const DESK_STATE: Record<DeskState, { icon: string; label: string }> = {
  working: { icon: "▶", label: "Working" },
  waiting: { icon: "?", label: "Waiting on you" },
  stuck: { icon: "!", label: "Stuck" },
  error: { icon: "!", label: "Error" },
  idle: { icon: "–", label: "Idle" },
  done: { icon: "✓", label: "Done" },
  stopped: { icon: "■", label: "Stopped" },
  closed: { icon: "×", label: "Closed" },
};

export interface Desk {
  key: string;
  kind: "subagent" | "in-agent";
  title: string;
  /** What the supervisor asked for. */
  ask: string | null;
  state: DeskState;
  now: string | null;
  /** Title of the desk this one reports to, when it isn't the supervisor (a grandchild). */
  reportsTo: string | null;
  /** The agent to open in chat; in-agent helpers open their parent. */
  open: { serverId: string; agentId: string } | null;
  startedAt: number;
  /** When it finished, if known. Finished desks stay in view for a while, then fold away. */
  endedAt: number | null;
}

/** A finished desk stays in the room this long before it folds into "N finished". */
export const FINISHED_VISIBLE_MS = 10 * 60_000;

export function isFinished(desk: Desk): boolean {
  return desk.state === "done" || desk.state === "stopped" || desk.state === "closed";
}

/** Finished desks fold away after FINISHED_VISIBLE_MS (or at once when the finish time is unknown). */
export function isFolded(desk: Desk, now: number): boolean {
  return isFinished(desk) && (desk.endedAt === null || now - desk.endedAt > FINISHED_VISIBLE_MS);
}

export interface Room {
  key: string;
  supervisor: AgentRow;
  supervisorState: DeskState;
  /** What the supervisor is doing now, or its last activity when idle. */
  supervisorNow: string | null;
  desks: Desk[];
}

const URGENCY: Record<DeskState, number> = { stuck: 0, waiting: 1, error: 2, working: 3, idle: 4, done: 4, stopped: 4, closed: 5 };

function agentState(row: AgentRow, isWorker: boolean): DeskState {
  if (isWorker && row.status === "idle" && row.marks.some((mark) => mark.kind === "finished")) return "done";
  return row.status as Exclude<AgentStatus, never>;
}

function helperState(helper: Helper): DeskState {
  return helper.status === "failed" ? "error" : helper.status;
}

function nowLine(row: AgentRow): string | null {
  if (row.now) return row.now;
  if (row.latestActivity) return row.status === "working" ? row.latestActivity : `Last: ${row.latestActivity}`;
  return null;
}

function helperDesks(row: AgentRow, reportsTo: string | null): Desk[] {
  return row.helpers.map((helper) => ({
    key: `helper:${row.serverId}:${row.id}:${helper.id}`,
    kind: "in-agent" as const,
    title: helper.type,
    ask: helper.ask,
    state: helperState(helper),
    now: helper.lastAction,
    reportsTo,
    open: { serverId: row.serverId, agentId: row.id },
    startedAt: helper.startedAt,
    endedAt: helper.endedAt,
  }));
}

export function buildRooms(agents: readonly AgentRow[], showClosed: boolean): Room[] {
  const visible = showClosed ? agents : agents.filter((agent) => agent.status !== "closed");
  const key = (agent: AgentRow) => `${agent.serverId}:${agent.id}`;
  const byKey = new Map(visible.map((agent) => [key(agent), agent]));
  const children = new Map<string, AgentRow[]>();
  const roots: AgentRow[] = [];
  for (const agent of visible) {
    const parentKey = agent.parentAgentId ? `${agent.serverId}:${agent.parentAgentId}` : null;
    if (parentKey && byKey.has(parentKey)) children.set(parentKey, [...(children.get(parentKey) ?? []), agent]);
    else roots.push(agent);
  }

  const rooms = roots.map((root): Room => {
    const desks: Desk[] = [];
    const seen = new Set<string>([key(root)]);
    const visit = (parent: AgentRow) => {
      const kids = (children.get(key(parent)) ?? []).sort((a, b) => a.since - b.since || a.title.localeCompare(b.title));
      for (const child of kids) {
        if (seen.has(key(child))) continue;
        seen.add(key(child));
        desks.push({
          key: key(child),
          kind: "subagent",
          title: child.title,
          ask: null,
          state: agentState(child, true),
          now: nowLine(child),
          reportsTo: parent === root ? null : parent.title,
          open: { serverId: child.serverId, agentId: child.id },
          startedAt: child.since,
          endedAt: child.marks.filter((mark) => mark.kind === "finished").pop()?.at ?? null,
        });
        visit(child);
      }
    };
    visit(root);
    // In-agent helpers of the supervisor, then of each Paseo subagent at its desk.
    const helpers = [
      ...helperDesks(root, null),
      ...[...seen].filter((k) => k !== key(root)).flatMap((k) => {
        const row = byKey.get(k);
        return row ? helperDesks(row, row.title) : [];
      }),
    ];
    desks.push(...helpers);
    // Desks that need you first; otherwise keep the handoff order (a stable sort).
    desks.sort((a, b) => URGENCY[a.state] - URGENCY[b.state]);
    return { key: key(root), supervisor: root, supervisorState: agentState(root, false), supervisorNow: nowLine(root), desks };
  });

  const rank = (room: Room) => Math.min(URGENCY[room.supervisorState], ...room.desks.map((desk) => URGENCY[desk.state]));
  // Rooms that need you first, then the most recently active.
  const latest = (room: Room) => Math.max(room.supervisor.since, ...room.desks.map((desk) => desk.endedAt ?? desk.startedAt));
  return rooms.sort((a, b) => rank(a) - rank(b) || latest(b) - latest(a) || a.supervisor.title.localeCompare(b.supervisor.title));
}

/** "2 working · 1 waiting on you · 3 done", for the room header and screen readers. */
export function roomSummary(room: Room): string {
  if (room.desks.length === 0) return "working alone";
  const counts = new Map<DeskState, number>();
  for (const desk of room.desks) counts.set(desk.state, (counts.get(desk.state) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => URGENCY[a[0]] - URGENCY[b[0]])
    .map(([state, count]) => `${count} ${DESK_STATE[state].label.toLowerCase()}`)
    .join(" · ");
}

/** Supervisor and desks that need you or are busy. */
function isActive(state: DeskState): boolean {
  return URGENCY[state] <= URGENCY.working;
}

/**
 * A quiet room: the supervisor isn't busy or asking, and no desk is busy, asking or just finished.
 * Quiet rooms fold into one line each, so the busy ones stay on screen.
 */
export function isQuiet(room: Room, now: number): boolean {
  if (isActive(room.supervisorState)) return false;
  return room.desks.every((desk) => !isActive(desk.state) && (!isFinished(desk) || isFolded(desk, now)));
}

export interface OfficeCounts {
  working: number;
  waiting: number;
  stuck: number;
  done: number;
}

/** Everyone in the office, supervisors and desks, by state. Stuck includes errors. */
export function officeCounts(rooms: readonly Room[]): OfficeCounts {
  const counts: OfficeCounts = { working: 0, waiting: 0, stuck: 0, done: 0 };
  const add = (state: DeskState) => {
    if (state === "working") counts.working += 1;
    else if (state === "waiting") counts.waiting += 1;
    else if (state === "stuck" || state === "error") counts.stuck += 1;
    else if (state === "done") counts.done += 1;
  };
  for (const room of rooms) {
    add(room.supervisorState);
    room.desks.forEach((desk) => add(desk.state));
  }
  return counts;
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "for 4m" while busy, "finished 3m ago" once done, else null. */
export function deskTime(desk: Desk, now: number): string | null {
  if (isFinished(desk) || desk.state === "error") return desk.endedAt !== null ? `${minutes(now - desk.endedAt)} ago` : null;
  if (isActive(desk.state)) return `for ${minutes(now - desk.startedAt)}`;
  return null;
}

/** Room subtitle: host, plus the branch when it says something the room name doesn't. */
export function roomMeta(supervisor: AgentRow): string {
  const branch = supervisor.branch && supervisor.branch !== supervisor.workspaceName ? supervisor.branch : null;
  return [supervisor.hostLabel, branch, supervisor.watched ? null : "read only"].filter(Boolean).join(" · ");
}
