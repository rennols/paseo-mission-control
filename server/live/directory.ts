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
): Promise<DirectoryObservation> {
  const result = await paseo.agents.list({ subscribe: {}, page: { limit: 200 }, includeBackground: false });
  registry.replaceHost(serverId, (result.entries as DirectoryEntry[]).map(({ agent, project }) => ({ agent, project })));
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
    },
  });

  return {
    async release() {
      stop();
      await result.subscription.release().catch(() => undefined);
    },
  };
}
