/**
 * Keeps the registry in step with a host's agent directory through the SDK's owned list
 * subscription: a snapshot first, then upserts and removals, and a fresh snapshot after a
 * reconnect. Used for this host and, through `paseo.hosts.client`, for other saved hosts.
 */
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { PluginLogger } from "../log";
import type { Placement, Registry } from "./registry";

interface DirectoryEntry {
  agent: PaseoAgent;
  project?: Placement | null;
}

export interface DirectoryObservation {
  release(): Promise<void>;
}

export async function observeDirectory(
  paseo: PaseoApi,
  serverId: string,
  registry: Registry,
  log: PluginLogger,
  feature: string,
  onError: (error: unknown) => void = () => undefined,
): Promise<DirectoryObservation> {
  const result = await paseo.agents.list({ subscribe: {}, page: { limit: 200 }, includeBackground: false });
  const entries = result.entries as DirectoryEntry[];
  registry.replaceHost(serverId, entries.map(({ agent, project }) => ({ agent, project })));
  log.info(feature, `Read ${entries.length} agents from ${serverId}`, {
    byStatus: countBy(entries.map(({ agent }) => (agent.activeTurn ? `${agent.status}+turn` : agent.status))),
    archived: entries.filter(({ agent }) => agent.archivedAt).length,
  });
  if (result.pageInfo.hasMore) log.warn(feature, `Host ${serverId} has more than 200 agents; showing the first 200`);

  const stop = result.subscription.subscribe({
    snapshot(snapshot) {
      registry.replaceHost(serverId, (snapshot.entries as DirectoryEntry[]).map(({ agent, project }) => ({ agent, project })));
    },
    update(message) {
      if (message.type !== "agent_update") return;
      const update = message.payload;
      if (update.kind === "upsert") registry.upsertFromDirectory(serverId, update.agent, update.project as Placement | null | undefined);
      else registry.remove(serverId, update.agentId);
    },
    error(error) {
      log.error(feature, `Agent directory for ${serverId} failed`, error);
      onError(error);
    },
  });

  return {
    async release() {
      stop();
      await result.subscription.release().catch(() => undefined);
    },
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
