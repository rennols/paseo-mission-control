/**
 * Needs you card actions. Each runs only from a click in the Live tab (an RPC call); nothing here
 * runs on its own. Allow once answers exactly one pending request and never adds a standing rule.
 */
import type { PaseoApi } from "@getpaseo/client";
import type { ActionResult } from "../../shared/live";
import { EXTEND_MINUTES } from "../../shared/settings";
import type { PluginLogger } from "../log";
import type { StateStore } from "../state/store";
import type { NeedsStore } from "./needs";

const FEATURE = "needs";

export interface NeedsActions {
  respondPermission(paseo: PaseoApi, input: { itemId: string; requestId: string; decision: "allow" | "deny" }): Promise<ActionResult>;
  sendHint(paseo: PaseoApi, input: { itemId: string; text: string }): Promise<ActionResult>;
  dismiss(input: { itemId: string }): ActionResult;
  extendTime(input: { itemId: string }): ActionResult;
}

/** The request's own action id for a plain allow or deny, when the provider offers actions. */
function actionId(actions: unknown, behavior: "allow" | "deny"): string | undefined {
  if (!Array.isArray(actions)) return undefined;
  const matching = actions.filter(
    (action): action is { id: string; behavior: string; intent?: string; variant?: string } =>
      typeof action?.id === "string" && action.behavior === behavior,
  );
  // Prefer the plain option: not "implement and resume", not a standing rule.
  const plain = matching.find((action) => !action.intent || action.intent === "dismiss") ?? matching[0];
  return plain?.id;
}

export function createNeedsActions(
  needs: NeedsStore,
  store: StateStore,
  resetCounters: (agentId: string) => void,
  agentTitle: (agentId: string) => string,
  log: PluginLogger,
): NeedsActions {
  function openItem(itemId: string) {
    const item = needs.get(itemId);
    if (!item) return { error: { ok: false, message: "That card no longer exists." } as ActionResult };
    if (item.resolvedAt !== null) return { error: { ok: false, message: item.resolution ?? "Already resolved." } as ActionResult };
    return { item };
  }

  return {
    async respondPermission(paseo, { itemId, requestId, decision }) {
      const { item, error } = openItem(itemId);
      if (!item) return error;
      if (item.kind !== "permission" || !item.requests.some((request) => request.requestId === requestId)) {
        return { ok: false, message: "That request is no longer pending." };
      }
      const agent = paseo.agents.ref(item.agentId);
      const snapshot = await agent.refresh();
      const pending = snapshot?.agent.pendingPermissions.find((request) => request.id === requestId);
      if (!pending) {
        needs.closePermission(item.agentId, requestId, "Answered elsewhere.");
        return { ok: false, message: "It was already answered elsewhere." };
      }
      const selectedActionId = actionId(pending.actions, decision);
      await agent.respondToPermission({
        requestId,
        response:
          decision === "allow"
            ? { behavior: "allow", ...(selectedActionId ? { selectedActionId } : {}) }
            : { behavior: "deny", message: "Denied from Mission Control", ...(selectedActionId ? { selectedActionId } : {}) },
      });
      log.info(FEATURE, `Permission ${decision === "allow" ? "allowed once" : "denied"} by the user`, { agentId: item.agentId, requestId });
      // The card closes when agent.permission.after arrives, whoever answered.
      return { ok: true, message: decision === "allow" ? "Allowed once." : "Denied." };
    },

    async sendHint(paseo, { itemId, text }) {
      const { item, error } = openItem(itemId);
      if (!item) return error;
      await paseo.agents.ref(item.agentId).send(text);
      resetCounters(item.agentId);
      needs.resolve(item.id, `Hint sent. ${agentTitle(item.agentId)} is working again.`);
      return { ok: true, message: "Hint sent." };
    },

    dismiss({ itemId }) {
      const { item, error } = openItem(itemId);
      if (!item) return error;
      if (item.kind === "permission") return { ok: false, message: "Answer the request with Allow once or Deny." };
      if (item.kind === "stuck") {
        store.state.metrics.stuckDismissed += 1;
        resetCounters(item.agentId);
        log.info(FEATURE, "Stuck flag dismissed by the user", { agentId: item.agentId, title: item.title });
      }
      needs.resolve(item.id, "Dismissed.");
      return { ok: true, message: "Dismissed." };
    },

    extendTime({ itemId }) {
      const { item, error } = openItem(itemId);
      if (!item) return error;
      if (item.kind !== "overtime") return { ok: false, message: "Only Over time cards can be extended." };
      store.state.overtimeExtensions[item.agentId] = (store.state.overtimeExtensions[item.agentId] ?? 0) + EXTEND_MINUTES;
      store.changed();
      needs.resolve(item.id, `Allowed ${EXTEND_MINUTES} more min.`);
      return { ok: true, message: `Allowed ${EXTEND_MINUTES} more min.` };
    },
  };
}
