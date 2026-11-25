/**
 * TEMPORARY. Step 0 only: logs every lifecycle hook and the shape of its payload so we can settle
 * the PRD's open questions on a real daemon. Delete this file and its line in index.server.ts
 * before building features.
 *
 * What it touches on your machine:
 * - Writes one JSON line per event to $PASEO_HOME/mission-control/hook-log.jsonl (default
 *   ~/.paseo/mission-control/hook-log.jsonl). Nothing else is written.
 * - Reads through the Paseo SDK only: the saved host list, the permission agent's snapshot,
 *   and the latest turn of an agent whose turn ended. It never sends, approves or changes anything.
 * - Redacts `env`, `headers` and any key that looks like a secret, and cuts long strings to 300
 *   characters. Prompts and file paths still appear, so read the file before pasting it anywhere.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "../log";
import { HOOK_NAMES, WAITING_HOOKS, type HookName, type PaseoAdapter, type PaseoApi } from "../paseo/adapter";
import { resolveStateDirectory } from "../paths";

const FEATURE = "hook-logger";
const MAX_STRING = 300;
const MAX_ARRAY = 20;
const MAX_DEPTH = 8;
const SECRET_KEY = /(^env$|headers|token|secret|password|passwd|authorization|cookie|api[-_]?key|credential)/i;

/** A type skeleton of a value, e.g. { agent: { id: "string", metadata: {} }, turnId: "string|null" }. */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (depth >= MAX_DEPTH) return [`array(${value.length})`];
    return [shapeOf(value[0], depth + 1), `length ${value.length}`];
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "object";
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : shapeOf(child, depth + 1);
    }
    return out;
  }
  return typeof value;
}

/** A copy safe to paste: secrets redacted, long strings and arrays cut. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`…(+${value.length - MAX_ARRAY} items)`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      out[key] =
        child && typeof child === "object" ? Object.fromEntries(Object.keys(child).map((k) => [k, "[redacted]"])) : "[redacted]";
    } else {
      out[key] = redact(child, depth + 1);
    }
  }
  return out;
}

/** Text of the final assistant message, if the timeline item looks like one. */
function assistantText(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (record.type === "assistant_message" && typeof record.text === "string") return record.text;
  return null;
}

export function registerHookLogger(adapter: PaseoAdapter, log: PluginLogger): () => void {
  const file = path.join(resolveStateDirectory(), "hook-log.jsonl");
  let seq = 0;
  let writes: Promise<void> = mkdir(path.dirname(file), { recursive: true }).then(() => undefined);

  function record(kind: string, data: Record<string, unknown>): void {
    const entry = { seq: ++seq, at: new Date().toISOString(), kind, ...data };
    const text = JSON.stringify(entry);
    console.log(text);
    // Writes are chained so lines stay in order; the hook handler never waits on them.
    writes = writes
      .then(() => appendFile(file, `${text}\n`, "utf8"))
      .catch((error: unknown) => log.error(FEATURE, `Could not write ${file}`, error));
  }

  let probedHosts = false;
  function probeOnce(paseo: PaseoApi): void {
    if (probedHosts) return;
    probedHosts = true;
    adapter.defer(FEATURE, "hosts probe", async () => {
      try {
        const directory = await paseo.hosts.list();
        record("probe.hosts", { shape: shapeOf(directory), value: redact(directory) });
      } catch (error) {
        record("probe.hosts", { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  const removers = HOOK_NAMES.map((name: HookName) =>
    adapter.addHook(name, FEATURE, async (payload, context) => {
      record("hook", {
        hook: name,
        waits: WAITING_HOOKS.has(name),
        paseoInstances: adapter.paseoInstanceCount(),
        shape: shapeOf(payload),
        payload: redact(payload),
      });
      probeOnce(context.paseo);

      if (name === "agent.permission.before") {
        const { agent } = payload as { agent: { id: string } };
        // Is the same request visible through the SDK? Answers "hooks or SDK for permissions".
        adapter.defer(FEATURE, "permission probe", async (paseo) => {
          const result = await paseo.agents.ref(agent.id).refresh();
          const pending = result?.agent.pendingPermissions ?? null;
          record("probe.pendingPermissions", { agentId: agent.id, shape: shapeOf(pending), value: redact(pending) });
        });
      }

      if (name === "agent.turn.after") {
        const { agent, turnId } = payload as { agent: { id: string }; turnId: string | null };
        // What does a finished turn look like? Feeds the summary card, the watchdog's error
        // signature and question detection.
        adapter.defer(FEATURE, "turn probe", async (paseo) => {
          const page = await paseo.agents.ref(agent.id).timeline.refetch({
            direction: "tail",
            limit: 1,
            wholeTurns: true,
          });
          const entries = page.entries.filter((entry) => entry.turnId === turnId);
          const items = entries.map((entry) => entry.item as unknown);
          const lastText = [...items].reverse().map(assistantText).find((text) => text !== null) ?? null;
          record("probe.turn", {
            agentId: agent.id,
            turnId,
            pageEntries: page.entries.length,
            matchingEntries: entries.length,
            itemTypes: items.map((item) => (item && typeof item === "object" ? (item as { type?: unknown }).type : typeof item)),
            itemShapes: items.slice(0, MAX_ARRAY).map((item) => shapeOf(item)),
            lastAssistantTextTail: lastText ? lastText.slice(-MAX_STRING) : null,
            endsWithQuestionMark: lastText ? lastText.trimEnd().endsWith("?") : null,
          });
        });
      }

      // Waiting hooks: returning undefined keeps Paseo's request unchanged.
      return undefined;
    }),
  );

  record("logger.started", { file, hooks: HOOK_NAMES, pid: process.pid, node: process.version });
  log.info(FEATURE, `Logging ${HOOK_NAMES.length} hooks to ${file}`);

  return () => {
    for (const remove of removers) remove();
  };
}
