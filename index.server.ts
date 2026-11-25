import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerHookLogger } from "./server/debug/hook-logger";
import { log } from "./server/log";
import { createPaseoAdapter } from "./server/paseo/adapter";

export default function contribute(server: PluginServerContext) {
  const paseo = createPaseoAdapter(server, log);

  // TEMPORARY (step 0): remove once the open questions are settled.
  const stopHookLogger = registerHookLogger(paseo, log);

  return () => {
    stopHookLogger();
  };
}
