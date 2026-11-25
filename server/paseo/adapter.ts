/**
 * The Paseo adapter. Every Paseo call in this plugin goes through this module: hook registration,
 * settings, RPC handlers and SDK calls. When Paseo's experimental plugin API changes, this is the
 * file that changes.
 *
 * Built and checked against @getpaseo/plugin 0.17.4. See paseo-plugin.json for the supported range.
 *
 * Rules enforced here, so features don't have to remember them:
 * - Hook handlers must return in under 50 ms. Slow work goes through `defer`, which runs it after
 *   the handler has returned. A handler that takes longer is logged as a warning.
 * - A failing handler never fails the Paseo operation and never stops another feature. Errors are
 *   caught and written to the plugin log. Waiting hooks that throw leave the request unchanged.
 */
import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginHookContext,
  PluginHookPayload,
  PluginHookResult,
  PluginHooks,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import type { PluginLogger } from "../log";

export type HookName = keyof PluginHooks;
export type HookPayload<Name extends HookName> = PluginHookPayload<Name>;
export type HookResult<Name extends HookName> = PluginHookResult<Name>;
export type HookHandler<Name extends HookName> = (
  payload: HookPayload<Name>,
  context: PluginHookContext,
) => Promise<HookResult<Name>>;

export type {
  PluginHookAgent as HookAgent,
  PluginHookWorkspace as HookWorkspace,
  PluginTurnOutcome as TurnOutcome,
} from "@getpaseo/plugin/server";
export type { PaseoApi };

/** Every hook Paseo 0.17.4 offers, in lifecycle order. */
export const HOOK_NAMES = [
  "workspace.create.before",
  "worktree.create.before",
  "worktree.create.after",
  "workspace.create.after",
  "agent.create.before",
  "agent.open.before",
  "agent.create.after",
  "agent.turn.before",
  "agent.permission.before",
  "agent.permission.after",
  "agent.turn.after",
  "agent.close.after",
  "agent.archive.after",
  "workspace.archive.after",
] as const satisfies readonly HookName[];

// Fails to compile if Paseo adds a hook that HOOK_NAMES does not list.
type UnlistedHook = Exclude<HookName, (typeof HOOK_NAMES)[number]>;
const allHooksListed: [UnlistedHook] extends [never] ? true : UnlistedHook = true;
void allHooksListed;

/** Hooks Paseo waits on. Their handlers receive `{ request }` and may return a replacement. */
export const WAITING_HOOKS: ReadonlySet<HookName> = new Set<HookName>([
  "workspace.create.before",
  "worktree.create.before",
  "worktree.create.after",
  "agent.create.before",
  "agent.open.before",
]);

const HANDLER_BUDGET_MS = 50;

export interface PaseoAdapter {
  /** Registers a hook handler. Returns an idempotent remover. */
  addHook<Name extends HookName>(name: Name, feature: string, handler: HookHandler<Name>): () => void;
  /** Runs slow work after the current handler returns. Errors are logged, never thrown. */
  defer(feature: string, label: string, work: (paseo: PaseoApi) => Promise<void>): void;
  /**
   * The plugin's Paseo SDK. Paseo creates one per plugin subprocess but only hands it to hook,
   * RPC and subscription handlers, not to the entry function (confirmed on 0.17.4). It is null
   * until the first of those runs.
   */
  paseo(): PaseoApi | null;
  /**
   * Calls `listener` once with the SDK, as soon as a hook, RPC or subscription handler has made it
   * available (at once if it already is). Returns a remover. Listener errors are logged.
   */
  onPaseo(feature: string, listener: (paseo: PaseoApi) => void): () => void;
  /** Records the SDK an RPC or subscription handler received, as hook handlers do. */
  capture(paseo: PaseoApi): void;
  /** How many distinct SDK instances handlers have received. Expected: 1. */
  paseoInstanceCount(): number;
  readonly registerSettings: PluginServerContext["registerSettings"];
  readonly handle: PluginServerContext["handle"];
}

export function createPaseoAdapter(server: PluginServerContext, log: PluginLogger): PaseoAdapter {
  const seen = new Set<PaseoApi>();
  let current: PaseoApi | null = null;
  const waiting = new Set<{ feature: string; listener: (paseo: PaseoApi) => void }>();

  function notify(paseo: PaseoApi, entry: { feature: string; listener: (paseo: PaseoApi) => void }): void {
    try {
      entry.listener(paseo);
    } catch (error) {
      log.error(entry.feature, "SDK listener failed", error);
    }
  }

  function capture(paseo: PaseoApi): void {
    if (!seen.has(paseo)) seen.add(paseo);
    const first = current === null;
    current = paseo;
    if (first && waiting.size > 0) {
      const entries = [...waiting];
      waiting.clear();
      // After the current handler returns, so a slow listener never holds up a hook.
      setImmediate(() => entries.forEach((entry) => notify(paseo, entry)));
    }
  }

  function onPaseo(feature: string, listener: (paseo: PaseoApi) => void): () => void {
    const entry = { feature, listener };
    if (current) {
      const paseo = current;
      setImmediate(() => notify(paseo, entry));
      return () => {};
    }
    waiting.add(entry);
    return () => waiting.delete(entry);
  }

  function defer(feature: string, label: string, work: (paseo: PaseoApi) => Promise<void>): void {
    const paseo = current;
    if (!paseo) {
      log.warn(feature, `Skipped ${label}: no Paseo SDK yet`);
      return;
    }
    setImmediate(() => {
      work(paseo).catch((error: unknown) => log.error(feature, `${label} failed`, error));
    });
  }

  function addHook<Name extends HookName>(
    name: Name,
    feature: string,
    handler: HookHandler<Name>,
  ): () => void {
    const guarded = async (
      payload: HookPayload<Name>,
      context: PluginHookContext,
    ): Promise<HookResult<Name>> => {
      capture(context.paseo);
      const started = performance.now();
      try {
        return await handler(payload, context);
      } catch (error) {
        log.error(feature, `${name} handler failed; Paseo continues unchanged`, error);
        return undefined as HookResult<Name>;
      } finally {
        const elapsed = performance.now() - started;
        if (elapsed > HANDLER_BUDGET_MS) {
          log.warn(feature, `${name} handler took ${elapsed.toFixed(1)} ms (budget ${HANDLER_BUDGET_MS} ms)`);
        }
      }
    };
    // `guarded` has the handler type for `name`; TypeScript can't narrow Paseo's per-name map
    // through a generic, so the cast is needed.
    return server.addHook(name, guarded as never);
  }

  return {
    addHook,
    defer,
    paseo: () => current,
    onPaseo,
    capture,
    paseoInstanceCount: () => seen.size,
    registerSettings: server.registerSettings.bind(server),
    handle: server.handle.bind(server) as PluginServerContext["handle"],
  };
}
