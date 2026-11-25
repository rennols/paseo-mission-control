/**
 * What the Add task form offers, and how a task's profile becomes a launch config. Read through the
 * Paseo SDK only: git projects Paseo knows on this host, saved agent profiles (Settings → host →
 * Agents → Agent profiles) and each ready provider's own defaults.
 *
 * Paseo's `create_agent` has no profile parameter (docs: MCP, Agent profiles), so a profile is
 * applied field by field, the way Paseo's docs tell orchestrators to: provider and model, mode,
 * thinking level and options. A profile with no model gets the provider's default model.
 */
import type { PaseoApi } from "@getpaseo/client";
import type { Choice } from "../../shared/queue";

const CACHE_MS = 60_000;
export const PROVIDER_PREFIX = "provider:";

export interface Project {
  id: string;
  name: string;
  path: string;
}

/** Loose shapes: these come from config and the provider snapshot, which change between releases. */
interface SavedProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

interface ProviderEntry {
  provider: string;
  label?: string;
  status?: string;
  enabled?: boolean;
  defaultModeId?: string | null;
  models?: { id: string; label?: string; isDefault?: boolean }[];
}

export interface LaunchConfig {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  options?: Record<string, unknown>;
}

export interface Catalog {
  projects: Project[];
  profiles: Choice[];
  error: string | null;
}

export interface CatalogService {
  /** Cached for 60 s; `fresh` re-reads. Never throws: errors land in `error`. */
  read(paseo: PaseoApi, fresh?: boolean): Promise<Catalog>;
  cached(): Catalog;
  project(key: string): Project | undefined;
  /** Resolves a profile key to a launch config at start time, so profile edits apply. */
  launchConfig(paseo: PaseoApi, profileKey: string): Promise<LaunchConfig>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCatalog(): CatalogService {
  let current: Catalog = { projects: [], profiles: [], error: null };
  let readAt = 0;
  let reading: Promise<Catalog> | null = null;

  async function load(paseo: PaseoApi): Promise<Catalog> {
    const errors: string[] = [];
    const projects: Project[] = [];
    const profiles: Choice[] = [];
    try {
      const result = await paseo.projects.list();
      for (const project of result.projects as unknown as Record<string, unknown>[]) {
        if (project.projectKind !== "git" || typeof project.projectRootPath !== "string") continue;
        const name = (typeof project.projectCustomName === "string" && project.projectCustomName) || String(project.projectDisplayName ?? project.projectRootPath);
        projects.push({ id: String(project.projectId), name, path: project.projectRootPath });
      }
      projects.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      errors.push(`Projects: ${message(error)}`);
    }
    try {
      const { config } = await paseo.config.get();
      for (const profile of ((config as { agentProfiles?: SavedProfile[] }).agentProfiles ?? [])) {
        profiles.push({ key: profile.id, label: profile.name, detail: `${profile.provider}${profile.model ? `/${profile.model}` : ""}` });
      }
    } catch (error) {
      errors.push(`Profiles: ${message(error)}`);
    }
    try {
      const snapshot = await paseo.providers.snapshot();
      for (const entry of snapshot.entries as unknown as ProviderEntry[]) {
        if (entry.status !== "ready" || entry.enabled === false) continue;
        const model = entry.models?.find((candidate) => candidate.isDefault) ?? entry.models?.[0];
        profiles.push({
          key: `${PROVIDER_PREFIX}${entry.provider}`,
          label: `${entry.label ?? entry.provider} defaults`,
          detail: [model?.label ?? model?.id, entry.defaultModeId ? `mode ${entry.defaultModeId}` : null].filter(Boolean).join(", ") || null,
        });
      }
    } catch (error) {
      errors.push(`Providers: ${message(error)}`);
    }
    return { projects, profiles, error: errors.length > 0 ? errors.join(". ") : null };
  }

  async function providerEntry(paseo: PaseoApi, provider: string): Promise<ProviderEntry | undefined> {
    const snapshot = await paseo.providers.snapshot();
    return (snapshot.entries as unknown as ProviderEntry[]).find((entry) => entry.provider === provider);
  }

  return {
    async read(paseo, fresh = false) {
      if (!fresh && Date.now() - readAt < CACHE_MS) return current;
      if (!reading) {
        reading = load(paseo)
          .then((catalog) => {
            current = catalog;
            readAt = Date.now();
            return catalog;
          })
          .finally(() => {
            reading = null;
          });
      }
      return reading;
    },
    cached: () => current,
    project: (key) => current.projects.find((project) => project.id === key),

    async launchConfig(paseo, profileKey) {
      let saved: SavedProfile | undefined;
      let providerId: string;
      if (profileKey.startsWith(PROVIDER_PREFIX)) {
        providerId = profileKey.slice(PROVIDER_PREFIX.length);
      } else {
        const { config } = await paseo.config.get();
        saved = ((config as { agentProfiles?: SavedProfile[] }).agentProfiles ?? []).find((profile) => profile.id === profileKey);
        if (!saved) throw new Error("Its agent profile no longer exists on this host");
        providerId = saved.provider;
      }
      const entry = await providerEntry(paseo, providerId);
      if (!entry || entry.status !== "ready" || entry.enabled === false) throw new Error(`Provider ${providerId} is not ready on this host`);
      const model = saved?.model ?? entry.models?.find((candidate) => candidate.isDefault)?.id ?? entry.models?.[0]?.id;
      if (!model) throw new Error(`Provider ${providerId} lists no models`);
      const modeId = saved?.modeId ?? entry.defaultModeId ?? undefined;
      const options = saved?.options ?? saved?.featureValues;
      return {
        provider: `${providerId}/${model}`,
        ...(modeId ? { modeId } : {}),
        ...(saved?.thinkingOptionId ? { thinkingOptionId: saved.thinkingOptionId } : {}),
        ...(options && Object.keys(options).length > 0 ? { options } : {}),
      };
    },
  };
}
