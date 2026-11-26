/**
 * Pure text and colour helpers for the Mission Control surfaces, kept out of the React modules so
 * they can be unit-tested without React Native.
 */
import type { AgentRow, AgentStatus } from "../shared/live";

export interface Group {
  key: string;
  name: string;
  hostLabel: string;
  watched: boolean;
  rows: { row: AgentRow; depth: number }[];
}

/** Lower is more urgent: groups with an agent that needs you sort first, closed ones last. */
const URGENCY: Record<AgentStatus, number> = { stuck: 0, waiting: 1, error: 2, working: 3, idle: 4, closed: 5 };

/**
 * Workspace groups, workers nested under the agent that started them (by parentAgentId). Groups
 * with a stuck or waiting agent come first, so on a phone they sit right under Needs you.
 */
export function buildGroups(agents: readonly AgentRow[]): Group[] {
  const byId = new Map(agents.map((agent) => [`${agent.serverId}:${agent.id}`, agent]));
  const children = new Map<string, AgentRow[]>();
  const roots: AgentRow[] = [];
  for (const agent of agents) {
    const parentKey = agent.parentAgentId ? `${agent.serverId}:${agent.parentAgentId}` : null;
    if (parentKey && byId.has(parentKey)) {
      const list = children.get(parentKey) ?? [];
      list.push(agent);
      children.set(parentKey, list);
    } else {
      roots.push(agent);
    }
  }
  const order = (a: AgentRow, b: AgentRow) => a.title.localeCompare(b.title);
  const groups = new Map<string, Group>();
  for (const root of roots.sort(order)) {
    const group = groups.get(root.workspaceKey) ?? {
      key: root.workspaceKey,
      name: root.workspaceName,
      hostLabel: root.hostLabel,
      watched: root.watched,
      rows: [],
    };
    groups.set(root.workspaceKey, group);
    const visit = (agent: AgentRow, depth: number, seen: Set<string>) => {
      const key = `${agent.serverId}:${agent.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      group.rows.push({ row: agent, depth });
      for (const child of (children.get(key) ?? []).sort(order)) visit(child, depth + 1, seen);
    };
    visit(root, 0, new Set());
  }
  const rank = (group: Group) => Math.min(...group.rows.map(({ row }) => URGENCY[row.status]));
  return [...groups.values()].sort(
    (a, b) => rank(a) - rank(b) || a.hostLabel.localeCompare(b.hostLabel) || a.name.localeCompare(b.name),
  );
}

/**
 * A see-through version of a theme colour, for tinted pill and card backgrounds. Paseo themes give
 * hex or rgb() colours; anything else falls back to transparent so the text still reads.
 */
export function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (hex) {
    let digits = hex[1] as string;
    if (digits.length === 3) digits = digits.replace(/./g, (c) => c + c);
    const [r, g, b] = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return "transparent";
}

/**
 * A shell permission arrives titled "Run <the whole command>". Show it as "Run this command" with
 * the command in a code block, so a long heredoc reads as code instead of a paragraph.
 */
export function presentRequest(title: string, detail: string | null): { title: string; detail: string | null } {
  if (detail === null && title.startsWith("Run ") && title.length > 4) return { title: "Run this command", detail: title.slice(4) };
  return { title, detail };
}

/**
 * The agent's last message, clamped to 8 lines in the card. Markdown marks (`code`, **bold**,
 * # headings, > quotes, list bullets) would show as raw characters in plain text, so they are
 * dropped. Lines inside ``` fences are code and stay as they are, only the fences go.
 */
export function plainSummary(text: string): string {
  return text
    .split(/^```[^\n]*\n?/m)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/`([^`\n]+)`/g, "$1")
            .replace(/\*\*([^*\n]+)\*\*/g, "$1")
            .replace(/__([^_\n]+)__/g, "$1")
            .replace(/^#{1,6}\s+/gm, "")
            .replace(/^>\s?/gm, "")
            .replace(/^\s*[-*]\s+/gm, "• "),
    )
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Permission titles name files by absolute path ("Write /home/me/.paseo/worktrees/x/y/a.md"). Inside
 * the agent's own folder the folder adds nothing on a phone, so show those paths from there.
 */
export function relativeToCwd(text: string, cwd: string | null | undefined): string {
  if (!cwd || cwd === "/") return text;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return text.split(base).join("");
}

/** A question option numbered from 1, so it can be answered by number in the chat. */
export function optionLabel(index: number, label: string): string {
  return `${index + 1}. ${label}`;
}

/** Whether a message is likely past a 4-line clamp at 360 px (about 45 characters a line). */
export function isLong(text: string): boolean {
  return text.length > 180 || text.split("\n").length > 4;
}
