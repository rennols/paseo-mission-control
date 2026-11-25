import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MissionControlScreen } from "./client/mission-control-screen";
import { QueueSettingsScreen } from "./client/queue-settings-screen";
import { SettingsScreen } from "./client/settings-screen";
import { LIVE_SCREEN_ID, MissionControlItem } from "./client/sidebar-item";
import { PLUGIN_NAME } from "./shared/plugin";

// The client only renders and calls RPCs; all state and logic live in the server entry.
export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: LIVE_SCREEN_ID, title: PLUGIN_NAME, Component: MissionControlScreen }),
    client.addSidebarFooterItem({ id: "mission-control", title: PLUGIN_NAME, Component: MissionControlItem }),
    client.addSettingsScreen({ id: "watchdog", title: "Watchdog", icon: "Radar", Component: SettingsScreen }),
    client.addSettingsScreen({ id: "queue", title: "Queue", icon: "ListOrdered", Component: QueueSettingsScreen }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
