/**
 * Sidebar footer entry: "N need you" on an amber badge while Needs you has open items, "All clear"
 * on a green one when it has none (Paseo's square sidebar badge; the words carry the meaning). The
 * count is pushed by the server (`needs.count.watch`) and equals the number of open cards on the
 * host the sidebar shows.
 */
import { useSubscription, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { needsCountWatch } from "../shared/live";
import { Pill } from "./parts";

export const LIVE_SCREEN_ID = "live";

export function MissionControlItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const [open, setOpen] = useState<number | null>(null);
  useSubscription(needsCountWatch, {}, (event) => setOpen(event.open));
  const label = open === null ? "…" : open === 0 ? "All clear" : `${open} need you`;
  return (
    <SidebarRow
      icon="Radar"
      label="Mission Control"
      active={currentScreen?.screenId === LIVE_SCREEN_ID}
      onPress={() => openScreen({ screenId: LIVE_SCREEN_ID })}
      trailing={
        open === null ? null : (
          <Pill theme={theme} square label={label} color={open === 0 ? theme.colors.statusSuccess : theme.colors.statusWarning} />
        )
      }
    />
  );
}

