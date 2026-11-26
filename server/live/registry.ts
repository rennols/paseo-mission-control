/**
 * Agent views for the Live tab, in memory. One registry holds every host: this host's agents are
 * fed by hooks and by an SDK directory subscription; other hosts' agents only by their directory
 * subscription (see ./remote-hosts.ts). Rebuilt on the first hook or RPC after the daemon starts.
 */
import type { PaseoAgent } from "@getpaseo/client";
import type { AgentRow, AgentStatus, LaneMark } from "../../shared/live";
import type { HookAgent } from "../paseo/adapter";
import { LANE_WINDOW_MS, buildLane, describeLane, laneKind, marksInWindow, recordTransition, type Transition } from "./lanes";

const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

/** Registry key for this host's agents. Other hosts are keyed by server id. */
export const LOCAL = "local";

/** The placement Paseo sends beside an agent in directory results. Read loosely: it is a union. */
export interface Placement {
  projectKey?: string;
  projectName?: string;
  workspaceName?: string | null;
  checkout?: { currentBranch?: string | null } | Record<string, unknown>;
}

export interface AgentEntry {
  id: string;
  serverId: string;
  title: string;
  provider: string;
  cwd: string;
  workspaceId: string | null;
  workspaceName: string | null;
  projectName: string | null;
  branch: string | null;
  parentAgentId: string | null;
  background: boolean;
  /** Paseo's lifecycle status: initializing, idle, running, error, closed. */
  lifecycle: string;
  pendingPermissions: number;
  createdAt: number;
  /** Start of the current run: the turn that took the agent from idle to running. */
  runStartedAt: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  latestActivity: string | null;
  transitions: Transition[];
  marks: LaneMark[];
  status: AgentStatus;
  statusSince: number;
}

/** Needs you facts the registry needs to derive a status. Local host only. */
export interface NeedsView {
  hasOpen(agentId: string, kind: "stuck" | "permission" | "question"): boolean;
}

function parseTime(value: string | null | undefined, fallback: number): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : fallback;
}

function providerName(provider: unknown): string {
  return typeof provider === "string" ? provider.split("/")[0] ?? provider : "agent";
}

function branchOf(placement: Placement | null | undefined): string | null {
  const checkout = placement?.checkout as { currentBranch?: unknown } | undefined;
  return typeof checkout?.currentBranch === "string" ? checkout.currentBranch : null;
}

/**
 * Paseo's status, except that an agent with an active turn counts as running whatever the status
 * says: a turn can be open while the status field still reads idle or initializing.
 */
export function lifecycleOf(agent: Pick<PaseoAgent, "status" | "activeTurn">): string {
  if (agent.activeTurn && agent.status !== "error" && agent.status !== "closed") return "running";
  return agent.status;
}

export interface Registry {
  entries(serverId?: string): AgentEntry[];
  get(serverId: string, agentId: string): AgentEntry | undefined;
  /** From a hook payload on this host. Creates the entry if the directory hasn't sent it yet. */
  upsertFromHook(serverId: string, agent: HookAgent): AgentEntry;
  /** From a directory snapshot or update (this host or another). */
  upsertFromDirectory(serverId: string, agent: PaseoAgent, placement: Placement | null | undefined): AgentEntry | null;
  remove(serverId: string, agentId: string): void;
  /** Replaces a host's whole agent set after a fresh directory snapshot. */
  replaceHost(serverId: string, agents: { agent: PaseoAgent; project: Placement | null | undefined }[]): void;
  dropHost(serverId: string): void;
  turnStarted(serverId: string, agentId: string, at: number): void;
  turnEnded(serverId: string, agentId: string, at: number, completed: boolean): void;
  addMark(serverId: string, agentId: string, mark: LaneMark): void;
  /** Re-derives every status (after Needs you changed) and records lane transitions. */
  refresh(at?: number): void;
  rows(hostLabels: ReadonlyMap<string, string>, serverIdOf: (key: string) => string, at?: number): AgentRow[];
  onChange(listener: () => void): () => void;
}

export function createRegistry(needs: NeedsView, now: () => number = Date.now): Registry {
  const hosts = new Map<string, Map<string, AgentEntry>>();
  const listeners = new Set<() => void>();

  function changed(): void {
    for (const listener of listeners) listener();
  }

  function hostMap(serverId: string): Map<string, AgentEntry> {
    let map = hosts.get(serverId);
    if (!map) {
      map = new Map();
      hosts.set(serverId, map);
    }
    return map;
  }

  function blank(serverId: string, id: string, at: number): AgentEntry {
    return {
      id,
      serverId,
      title: "Agent",
      provider: "agent",
      cwd: "",
      workspaceId: null,
      workspaceName: null,
      projectName: null,
      branch: null,
      parentAgentId: null,
      background: false,
      lifecycle: "idle",
      pendingPermissions: 0,
      createdAt: at,
      runStartedAt: null,
      linesAdded: null,
      linesRemoved: null,
      latestActivity: null,
      transitions: [{ kind: "idle", at }],
      marks: [],
      status: "idle",
      statusSince: at,
    };
  }

  function derive(entry: AgentEntry): AgentStatus {
    const local = entry.serverId === LOCAL;
    if (local && needs.hasOpen(entry.id, "stuck")) return "stuck";
    if (entry.pendingPermissions > 0) return "waiting";
    if (local && (needs.hasOpen(entry.id, "permission") || needs.hasOpen(entry.id, "question"))) return "waiting";
    if (entry.lifecycle === "running" || entry.lifecycle === "initializing") return "working";
    if (entry.lifecycle === "error") return "error";
    if (entry.lifecycle === "closed") return "closed";
    return "idle";
  }

  function settle(entry: AgentEntry, at: number): boolean {
    const status = derive(entry);
    if (status === entry.status) return false;
    entry.status = status;
    entry.statusSince = at;
    entry.transitions = recordTransition(entry.transitions, laneKind(status), at);
    return true;
  }

  function applyDirectory(entry: AgentEntry, agent: PaseoAgent, placement: Placement | null | undefined, at: number): void {
    entry.title = agent.title?.trim() || entry.title;
    entry.provider = providerName(agent.provider);
    entry.cwd = agent.cwd;
    entry.workspaceId = agent.workspaceId ?? entry.workspaceId;
    entry.workspaceName = placement?.workspaceName ?? entry.workspaceName;
    entry.projectName = placement?.projectName ?? entry.projectName;
    entry.branch = branchOf(placement) ?? entry.branch;
    entry.parentAgentId = agent.labels?.[PARENT_AGENT_LABEL] ?? entry.parentAgentId;
    entry.background = agent.background === true;
    entry.createdAt = parseTime(agent.createdAt, entry.createdAt);
    entry.pendingPermissions = agent.pendingPermissions?.length ?? 0;
    const wasRunning = entry.lifecycle === "running";
    entry.lifecycle = lifecycleOf(agent);
    if (entry.lifecycle === "running") {
      if (!wasRunning || entry.runStartedAt === null) entry.runStartedAt = parseTime(agent.activeTurn?.startedAt ?? null, at);
    } else {
      entry.runStartedAt = null;
    }
    if (agent.archivedAt) entry.lifecycle = "closed";
  }

  const registry: Registry = {
    entries(serverId) {
      if (serverId) return [...(hosts.get(serverId)?.values() ?? [])];
      return [...hosts.values()].flatMap((map) => [...map.values()]);
    },

    get: (serverId, agentId) => hosts.get(serverId)?.get(agentId),

    upsertFromHook(serverId, agent) {
      const at = now();
      const map = hostMap(serverId);
      const entry = map.get(agent.id) ?? blank(serverId, agent.id, at);
      map.set(agent.id, entry);
      entry.title = agent.title?.trim() || entry.title;
      entry.provider = providerName(agent.provider);
      entry.cwd = agent.cwd;
      entry.workspaceId = agent.workspaceId ?? entry.workspaceId;
      entry.parentAgentId = agent.parentAgentId ?? entry.parentAgentId;
      entry.background = agent.background === true;
      if (settle(entry, at)) changed();
      return entry;
    },

    upsertFromDirectory(serverId, agent, placement) {
      if (agent.archivedAt) {
        registry.remove(serverId, agent.id);
        return null;
      }
      const at = now();
      const map = hostMap(serverId);
      const entry = map.get(agent.id) ?? blank(serverId, agent.id, parseTime(agent.createdAt, at));
      map.set(agent.id, entry);
      applyDirectory(entry, agent, placement, at);
      settle(entry, at);
      changed();
      return entry;
    },

    remove(serverId, agentId) {
      if (hosts.get(serverId)?.delete(agentId)) changed();
    },

    replaceHost(serverId, agents) {
      const at = now();
      const previous = hosts.get(serverId) ?? new Map<string, AgentEntry>();
      const next = new Map<string, AgentEntry>();
      for (const { agent, project } of agents) {
        if (agent.archivedAt) continue;
        const entry = previous.get(agent.id) ?? blank(serverId, agent.id, parseTime(agent.createdAt, at));
        applyDirectory(entry, agent, project, at);
        settle(entry, at);
        next.set(agent.id, entry);
      }
      hosts.set(serverId, next);
      changed();
    },

    dropHost(serverId) {
      if (hosts.delete(serverId)) changed();
    },

    turnStarted(serverId, agentId, at) {
      const entry = hosts.get(serverId)?.get(agentId);
      if (!entry) return;
      if (entry.lifecycle !== "running" || entry.runStartedAt === null) entry.runStartedAt = at;
      entry.lifecycle = "running";
      settle(entry, at);
      changed();
    },

    turnEnded(serverId, agentId, at, completed) {
      const entry = hosts.get(serverId)?.get(agentId);
      if (!entry) return;
      entry.lifecycle = "idle";
      entry.runStartedAt = null;
      if (completed) {
        entry.marks = [...entry.marks.filter((mark) => mark.kind !== "finished" && at - mark.at < LANE_WINDOW_MS), { kind: "finished", at }];
      }
      settle(entry, at);
      changed();
    },

    addMark(serverId, agentId, mark) {
      const entry = hosts.get(serverId)?.get(agentId);
      if (!entry) return;
      entry.marks = [...entry.marks.filter((m) => mark.at - m.at < LANE_WINDOW_MS), mark];
      changed();
    },

    refresh(at = now()) {
      let any = false;
      for (const map of hosts.values()) for (const entry of map.values()) any = settle(entry, at) || any;
      if (any) changed();
    },

    rows(hostLabels, serverIdOf, at = now()) {
      const rows: AgentRow[] = [];
      for (const [serverId, map] of hosts) {
        for (const entry of map.values()) {
          if (entry.background) continue;
          const lane = buildLane(entry.transitions, at);
          const marks = marksInWindow(entry.marks, at);
          const workspaceName = entry.workspaceName ?? entry.projectName ?? (entry.cwd.split(/[\\/]/).filter(Boolean).pop() || "No workspace");
          rows.push({
            id: entry.id,
            serverId: serverIdOf(serverId),
            hostLabel: hostLabels.get(serverId) ?? serverId,
            title: entry.title,
            provider: entry.provider,
            workspaceKey: `${serverId}:${entry.workspaceId ?? entry.cwd}`,
            workspaceName,
            branch: entry.branch,
            parentAgentId: entry.parentAgentId,
            status: entry.status,
            since: entry.status === "working" && entry.runStartedAt !== null ? entry.runStartedAt : entry.statusSince,
            linesAdded: entry.linesAdded,
            linesRemoved: entry.linesRemoved,
            latestActivity: entry.latestActivity,
            now: null,
            nowKind: null,
            helpers: [],
            lane,
            marks,
            laneDescription: describeLane(lane, marks),
            watched: serverId === LOCAL,
          });
        }
      }
      return rows;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return registry;
}
