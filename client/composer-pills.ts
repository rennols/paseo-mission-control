/**
 * Composer track pills and `/p` (PRD: Chat, Quick replies and saved prompts).
 *
 * - One quick reply pill per reply on every agent's composer track.
 * - A Prompts pill that opens a menu of saved prompts.
 * - `/p <name>`, which Paseo clears from the composer before calling us; we put the prompt back.
 *
 * Every one of them inserts text into that agent's composer and focuses it. None of them sends.
 *
 * Settings come from the server (`chat.settings.watch`); agents and their branch come from Paseo's
 * own agent list subscription, as in Paseo's local-plugin example. Background agents get no pills.
 */
import type { PluginButtonMenuEntry, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { chatSettingsWatch, type QuickReply, type SavedPrompt } from "../shared/chat";
import { expandPrompt, findPrompt, type PromptContext } from "../shared/prompts";

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  background?: boolean | null;
  archivedAt?: unknown;
  title?: string | null;
}

/** The placement Paseo sends beside an agent. Read loosely: it is a union. */
interface PlacementLike {
  workspaceName?: string | null;
  projectName?: string | null;
  checkout?: { currentBranch?: unknown } | null;
}

/** Pill ids: lowercase letters, digits and hyphens. */
export function pillId(index: number): string {
  return `reply-${index + 1}`;
}
export const PROMPTS_PILL_ID = "prompts";

export function promptMenuId(name: string): string {
  return `prompt-${name}`;
}

/** The context a prompt is filled from, read when the user picks it so it is never stale. */
export function contextOf(agent: AgentLike | undefined, placement: PlacementLike | null | undefined): PromptContext {
  const branch = placement?.checkout?.currentBranch;
  return {
    branch: typeof branch === "string" ? branch : null,
    workspace: placement?.workspaceName ?? placement?.projectName ?? null,
    agent: agent?.title ?? null,
  };
}

async function insertInto(client: PluginClientContext, agentId: string, text: string): Promise<void> {
  const composers = client.composers({ agentId });
  if (composers.length === 0) throw new Error("This agent's message box isn't available.");
  for (const composer of composers) {
    composer.insertText(text);
    await composer.focus();
  }
}

export function startComposerPills(client: PluginClientContext): () => void {
  const agents = new Map<string, AgentLike>();
  const placements = new Map<string, PlacementLike | null>();
  const pills = new Map<string, PluginButtonRegistration[]>();
  let replies: QuickReply[] = [];
  let prompts: SavedPrompt[] = [];
  let repliesOn = false;
  let promptsOn = false;
  let removeSlash: (() => void) | null = null;
  let stopped = false;
  const lifetime = new AbortController();

  function clear(agentId: string): void {
    for (const pill of pills.get(agentId) ?? []) pill.remove();
    pills.delete(agentId);
  }

  function insertPrompt(agentId: string, prompt: SavedPrompt): Promise<void> {
    return insertInto(client, agentId, expandPrompt(prompt.text, contextOf(agents.get(agentId), placements.get(agentId))));
  }

  function promptMenu(agentId: string): PluginButtonMenuEntry[] {
    return prompts.map((prompt) => ({
      kind: "item" as const,
      id: promptMenuId(prompt.name),
      title: `/${prompt.name}`,
      icon: "FileText",
      behavior: { kind: "action" as const, onPress: () => insertPrompt(agentId, prompt) },
    }));
  }

  function register(agent: AgentLike): void {
    clear(agent.id);
    if (stopped || !agent.workspaceId || agent.background || agent.archivedAt) return;
    const workspaceId = agent.workspaceId;
    const agentId = agent.id;
    const registered: PluginButtonRegistration[] = [];
    if (repliesOn) {
      for (const [index, reply] of replies.entries()) {
        registered.push(
          client.addComposerPill({
            id: pillId(index),
            workspaceId,
            agentId,
            button: {
              title: `Put "${reply.text}" in the message box`,
              icon: "Reply",
              label: reply.label,
              behavior: { kind: "action", onPress: () => insertInto(client, agentId, reply.text) },
            },
          }),
        );
      }
    }
    if (promptsOn && prompts.length > 0) {
      registered.push(
        client.addComposerPill({
          id: PROMPTS_PILL_ID,
          workspaceId,
          agentId,
          button: {
            title: "Put a saved prompt in the message box",
            icon: "BookText",
            label: "Prompts",
            behavior: { kind: "menu", items: promptMenu(agentId) },
          },
        }),
      );
    }
    pills.set(agentId, registered);
  }

  function registerAll(): void {
    for (const agent of agents.values()) register(agent);
  }

  function syncSlashCommand(): void {
    const wanted = !stopped && promptsOn;
    if (wanted && !removeSlash) {
      removeSlash = client.addSlashCommand({
        name: "p",
        description: "Put a saved prompt in the message box (it isn't sent)",
        argumentHint: "<name>",
        context: "agent",
        async onSubmit({ args, agent, workspace }) {
          const found = findPrompt(prompts, args);
          if (!found.ok) throw new Error(found.message);
          const placement = placements.get(agent.id);
          const context = contextOf({ ...agents.get(agent.id), id: agent.id, title: agent.title }, placement);
          // Paseo's own snapshot of the workspace is the freshest source when it has a value.
          const filled: PromptContext = {
            branch: workspace.branch ?? context.branch,
            workspace: context.workspace ?? workspace.title ?? workspace.name,
            agent: context.agent,
          };
          await insertInto(client, agent.id, expandPrompt(found.prompt.text, filled));
        },
      });
    } else if (!wanted && removeSlash) {
      removeSlash();
      removeSlash = null;
    }
  }

  const settings = client.subscribe(chatSettingsWatch, {}, (event) => {
    repliesOn = event.quickReplies;
    replies = event.replies;
    promptsOn = event.savedPrompts;
    prompts = event.prompts;
    syncSlashCommand();
    registerAll();
  });

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const agentId of [...pills.keys()]) clear(agentId);
          agents.clear();
          placements.clear();
          for (const entry of entries) {
            agents.set(entry.agent.id, entry.agent as AgentLike);
            placements.set(entry.agent.id, (entry as { project?: PlacementLike | null }).project ?? null);
          }
          registerAll();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            agents.delete(update.agentId);
            placements.delete(update.agentId);
            clear(update.agentId);
            return;
          }
          const agent = update.agent as AgentLike;
          const known = agents.get(agent.id);
          agents.set(agent.id, agent);
          const project = (update as { project?: PlacementLike | null }).project;
          if (project !== undefined) placements.set(agent.id, project);
          // Re-register only when what the pills depend on changed, so pills don't flicker on every
          // status tick. Titles and branches are read when a prompt is picked.
          if (
            !known ||
            known.workspaceId !== agent.workspaceId ||
            Boolean(known.background) !== Boolean(agent.background) ||
            Boolean(known.archivedAt) !== Boolean(agent.archivedAt)
          ) {
            register(agent);
          }
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[mission-control] Agent list for composer pills failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    settings();
    syncSlashCommand();
    for (const agentId of [...pills.keys()]) clear(agentId);
  };
}
