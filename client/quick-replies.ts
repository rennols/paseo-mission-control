/**
 * Quick reply pills (PRD: Chat, Quick replies). One pill per reply on every agent's composer track.
 * A pill inserts its text into that agent's composer and focuses it. It never sends.
 *
 * The reply list comes from the server (`chat.settings.watch`); agents come from Paseo's own agent
 * list subscription, as in Paseo's local-plugin example. Background agents get no pills.
 */
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { chatSettingsWatch, type QuickReply } from "../shared/chat";

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  background?: boolean | null;
  archivedAt?: unknown;
}

/** Pill ids: lowercase letters, digits and hyphens. */
export function pillId(index: number): string {
  return `reply-${index + 1}`;
}

export function startQuickReplies(client: PluginClientContext): () => void {
  const agents = new Map<string, AgentLike>();
  const pills = new Map<string, PluginButtonRegistration[]>();
  let replies: QuickReply[] = [];
  let enabled = false;
  let stopped = false;
  const lifetime = new AbortController();

  function clear(agentId: string): void {
    for (const pill of pills.get(agentId) ?? []) pill.remove();
    pills.delete(agentId);
  }

  function register(agent: AgentLike): void {
    clear(agent.id);
    if (stopped || !enabled || !agent.workspaceId || agent.background || agent.archivedAt) return;
    const workspaceId = agent.workspaceId;
    const agentId = agent.id;
    pills.set(
      agentId,
      replies.map((reply, index) =>
        client.addComposerPill({
          id: pillId(index),
          workspaceId,
          agentId,
          button: {
            title: `Put "${reply.text}" in the message box`,
            icon: "Reply",
            label: reply.label,
            behavior: {
              kind: "action",
              async onPress() {
                for (const composer of client.composers({ agentId })) {
                  composer.insertText(reply.text);
                  await composer.focus();
                }
              },
            },
          },
        }),
      ),
    );
  }

  function registerAll(): void {
    for (const agent of agents.values()) register(agent);
  }

  const settings = client.subscribe(chatSettingsWatch, {}, (event) => {
    enabled = event.quickReplies;
    replies = event.replies;
    registerAll();
  });

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const agentId of [...pills.keys()]) clear(agentId);
          agents.clear();
          for (const { agent } of entries) agents.set(agent.id, agent as AgentLike);
          registerAll();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            agents.delete(update.agentId);
            clear(update.agentId);
            return;
          }
          const agent = update.agent as AgentLike;
          const known = agents.get(agent.id);
          agents.set(agent.id, agent);
          // Re-register only when what the pills depend on changed, so pills don't flicker on every status tick.
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
      if (!stopped) console.error("[mission-control] Agent list for quick replies failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    settings();
    for (const agentId of [...pills.keys()]) clear(agentId);
  };
}
