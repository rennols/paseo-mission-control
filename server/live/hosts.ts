/**
 * Which hosts the Live tab shows, and the directory subscriptions that feed it. This host's agents
 * are keyed as LOCAL in the registry; other saved hosts by their server id, read through
 * `paseo.hosts.client(serverId)` (one hop; hooks never cross hosts, so those rows are read-only).
 *
 * Network: talks only to the hosts saved in this daemon (PRD: no other network calls). The host
 * list is re-read every 60 s while the plugin runs, to pick up hosts going on or offline.
 */
import type { PaseoApi } from "@getpaseo/client";
import type { LiveHost } from "../../shared/live";
import type { PluginLogger } from "../log";
import { observeDirectory, type DirectoryObservation } from "./directory";
import { LOCAL, type Registry } from "./registry";
const FEATURE = "hosts";
const HOSTS_REFRESH_MS = 60_000;

interface Remote {
  api: PaseoApi;
  observation: DirectoryObservation;
}

export interface HostsService {
  /** Starts the local directory now, and other hosts' directories on `includeRemote()`. */
  start(paseo: PaseoApi): void;
  /** Called when the Live tab first opens: other hosts are only read while someone looks. */
  includeRemote(): void;
  self(): { serverId: string; label: string };
  summaries(): LiveHost[];
  /** Registry key → label, for rows. */
  labels(): Map<string, string>;
  /** Registry key → real server id, for navigation. */
  serverIdOf(key: string): string;
  stop(): Promise<void>;
}

export function createHostsService(registry: Registry, log: PluginLogger, onChange: () => void): HostsService {
  let paseo: PaseoApi | null = null;
  let self = { serverId: LOCAL, label: "This host" };
  let hosts: LiveHost[] = [];
  let local: DirectoryObservation | null = null;
  let remoteWanted = false;
  const remotes = new Map<string, Remote>();
  const connecting = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function connectRemote(serverId: string): Promise<void> {
    if (!paseo || remotes.has(serverId) || connecting.has(serverId)) return;
    connecting.add(serverId);
    try {
      const api = await paseo.hosts.client(serverId);
      const observation = await observeDirectory(api, serverId, registry, log, FEATURE);
      if (stopped) {
        await observation.release();
        await api.dispose();
        return;
      }
      remotes.set(serverId, { api, observation });
      log.info(FEATURE, `Reading agents from host ${serverId}`);
    } catch (error) {
      log.warn(FEATURE, `Could not read agents from host ${serverId}`, error instanceof Error ? error.message : String(error));
      const host = hosts.find((candidate) => candidate.serverId === serverId);
      if (host) host.error = error instanceof Error ? error.message : String(error);
      onChange();
    } finally {
      connecting.delete(serverId);
    }
  }

  async function disconnectRemote(serverId: string): Promise<void> {
    const remote = remotes.get(serverId);
    remotes.delete(serverId);
    registry.dropHost(serverId);
    if (!remote) return;
    await remote.observation.release().catch(() => undefined);
    await remote.api.dispose().catch(() => undefined);
  }

  async function refreshHosts(): Promise<void> {
    if (!paseo || stopped) return;
    try {
      const directory = await paseo.hosts.list();
      self = { serverId: directory.self.serverId, label: directory.self.label };
      hosts = [
        { serverId: self.serverId, label: self.label, self: true, status: "online", error: null },
        ...directory.hosts
          .filter((host) => host.serverId && host.serverId !== self.serverId)
          .map((host) => ({
            serverId: host.serverId as string,
            label: host.label ?? host.targetDescription,
            self: false,
            status: host.enabled ? host.status : "disabled",
            error: host.error?.message ?? null,
          })),
      ];
      if (remoteWanted) {
        const online = new Set(hosts.filter((host) => !host.self && host.status === "online").map((host) => host.serverId));
        for (const serverId of online) void connectRemote(serverId);
        for (const serverId of [...remotes.keys()]) if (!online.has(serverId)) void disconnectRemote(serverId);
      }
      onChange();
    } catch (error) {
      log.error(FEATURE, "Could not list saved hosts", error);
    }
  }

  return {
    start(api) {
      if (paseo) return;
      paseo = api;
      void observeDirectory(api, LOCAL, registry, log, FEATURE)
        .then((observation) => {
          if (stopped) void observation.release();
          else local = observation;
        })
        .catch((error: unknown) => log.error(FEATURE, "Could not read this host's agents", error));
      void refreshHosts();
      timer = setInterval(() => void refreshHosts(), HOSTS_REFRESH_MS);
      timer.unref?.();
    },
    includeRemote() {
      if (remoteWanted) return;
      remoteWanted = true;
      void refreshHosts();
    },
    self: () => self,
    summaries: () => (hosts.length > 0 ? hosts : [{ serverId: self.serverId, label: self.label, self: true, status: "online", error: null }]),
    labels() {
      const labels = new Map<string, string>([[LOCAL, self.label]]);
      for (const host of hosts) if (!host.self) labels.set(host.serverId, host.label);
      return labels;
    },
    serverIdOf: (key) => (key === LOCAL ? self.serverId : key),
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await local?.release().catch(() => undefined);
      await Promise.all([...remotes.keys()].map((serverId) => disconnectRemote(serverId)));
    },
  };
}
