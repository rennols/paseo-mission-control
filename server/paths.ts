import { homedir } from "node:os";
import path from "node:path";
import { PLUGIN_ID } from "../shared/plugin";

/**
 * Paseo has no documented data directory for plugin state (checked against 0.17.4). The daemon
 * resolves its home as `$PASEO_HOME`, defaulting to `~/.paseo`, and the plugin subprocess inherits
 * the daemon's environment, so we resolve it the same way.
 *
 * Settings are not stored here: `server.registerSettings` keeps them under
 * `$PASEO_HOME/plugin-settings/<plugin id>/`, which Paseo deletes on `paseo plugin remove`.
 * This directory is ours and survives removal.
 */
export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PASEO_HOME ?? "~/.paseo";
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

export function resolveStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePaseoHome(env), PLUGIN_ID);
}
