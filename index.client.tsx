import type { PluginClientContext } from "@getpaseo/plugin/client";

// The client only renders and calls RPCs. Nothing is registered until the P0 features land.
export default function contribute(_client: PluginClientContext) {
  return () => {};
}
