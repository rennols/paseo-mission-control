/**
 * Plugin log. `console.log` and `console.error` go to the plugin's stdout and stderr, which Paseo
 * keeps as the tail shown by `paseo plugin logs mission-control` and copies to the daemon log.
 * Never log credentials or other secrets.
 */
export interface PluginLogger {
  info(feature: string, message: string, data?: unknown): void;
  warn(feature: string, message: string, data?: unknown): void;
  error(feature: string, message: string, error?: unknown): void;
}

function line(level: string, feature: string, message: string, data?: unknown): string {
  const entry: Record<string, unknown> = { level, feature, message, at: new Date().toISOString() };
  if (data !== undefined) entry.data = data;
  return JSON.stringify(entry);
}

function describeError(error: unknown): unknown {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return error;
}

export const log: PluginLogger = {
  info: (feature, message, data) => console.log(line("info", feature, message, data)),
  warn: (feature, message, data) => console.error(line("warn", feature, message, data)),
  error: (feature, message, error) =>
    console.error(line("error", feature, message, describeError(error))),
};
