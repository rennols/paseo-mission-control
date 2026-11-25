/**
 * Badges for sidebar workspace (branch) rows (PRD: Branch row badges). A row gets one badge per
 * kind of open Needs you item among the agents in that workspace (both agents of a collision); rows with nothing open get none,
 * so Paseo's own status dot and time stay the main signal. Pure: the feed pushes the result.
 */
import type { NeedsItem, NeedsKind, RowBadge } from "../../shared/live";

/** Same order as the Needs you list: most urgent first. */
const ORDER: NeedsKind[] = ["permission", "question", "stuck", "overtime", "collision"];

const WORD: Record<NeedsKind, string> = { permission: "approve", question: "question", stuck: "stuck", overtime: "over", collision: "overlap" };

const DESCRIBE: Record<NeedsKind, (n: number) => string> = {
  permission: (n) => `${n === 1 ? "1 agent" : `${n} agents`} waiting for approval`,
  question: (n) => `${n === 1 ? "1 agent" : `${n} agents`} asked a question`,
  stuck: (n) => `${n === 1 ? "1 agent looks" : `${n} agents look`} stuck`,
  overtime: (n) => `${n === 1 ? "1 agent" : `${n} agents`} over the time limit`,
  collision: (n) => `${n === 1 ? "1 agent edits" : `${n} agents edit`} the same lines as an agent in another worktree`,
};

export function rowBadges(
  open: readonly (Pick<NeedsItem, "agentId" | "kind" | "resolvedAt"> & Partial<Pick<NeedsItem, "relatedAgentIds">>)[],
  workspaceOf: (agentId: string) => string | null | undefined,
  timeLimitMinutes: number,
): Record<string, RowBadge[]> {
  // workspace -> kind -> agents (an agent with two cards of one kind counts once)
  const byWorkspace = new Map<string, Map<NeedsKind, Set<string>>>();
  for (const item of open) {
    if (item.resolvedAt !== null) continue;
    // A collision badges both sides of the overlap.
    for (const agentId of [item.agentId, ...(item.relatedAgentIds ?? [])]) {
      const workspaceId = workspaceOf(agentId);
      if (!workspaceId) continue;
      const kinds = byWorkspace.get(workspaceId) ?? new Map<NeedsKind, Set<string>>();
      byWorkspace.set(workspaceId, kinds);
      const agents = kinds.get(item.kind) ?? new Set<string>();
      kinds.set(item.kind, agents);
      agents.add(agentId);
    }
  }
  const result: Record<string, RowBadge[]> = {};
  for (const [workspaceId, kinds] of byWorkspace) {
    result[workspaceId] = ORDER.filter((kind) => kinds.has(kind)).map((kind) => {
      const count = kinds.get(kind)!.size;
      const word = kind === "overtime" ? `over ${timeLimitMinutes}m` : WORD[kind];
      return { kind, label: count > 1 ? `${count} ${word}` : word, description: `Mission Control: ${DESCRIBE[kind](count)}` };
    });
  }
  return result;
}
