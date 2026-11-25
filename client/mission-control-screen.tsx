/**
 * The Mission Control screen: three tabs, Live, Queue and Review inbox (PRD: Mission Control
 * screen). The tab labels carry the queued and ready-for-review counts the server pushes on
 * `work.count.watch`. Open on a tab with the screen param `tab` ("live", "queue" or "inbox").
 */
import { useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { workCountWatch } from "../shared/queue";
import { InboxScreen } from "./inbox-screen";
import { LiveScreen } from "./live-screen";
import { QueueScreen } from "./queue-screen";

type Tab = "live" | "queue" | "inbox";

export function MissionControlScreen(props: PluginScreenProps) {
  const { theme, layout, params } = props;
  const initial: Tab = params.tab === "queue" || params.tab === "inbox" ? params.tab : "live";
  const [tab, setTab] = useState<Tab>(initial);
  const [counts, setCounts] = useState<{ queued: number; review: number } | null>(null);
  useSubscription(workCountWatch, {}, setCounts);

  const tabs: { key: Tab; label: string }[] = [
    { key: "live", label: "Live" },
    { key: "queue", label: counts ? `Queue · ${counts.queued}` : "Queue" },
    { key: "inbox", label: counts ? `Review inbox · ${counts.review}` : "Review inbox" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 4,
          paddingHorizontal: layout.compact ? 8 : 16,
          paddingTop: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        {tabs.map((item) => {
          const active = item.key === tab;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={item.label}
              onPress={() => setTab(item.key)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderBottomWidth: 2,
                borderBottomColor: active ? theme.colors.accent : "transparent",
              }}
            >
              <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13, fontWeight: active ? "600" : "400" }}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flex: 1 }}>
        {tab === "live" ? <LiveScreen {...props} /> : tab === "queue" ? <QueueScreen {...props} onOpenInbox={() => setTab("inbox")} /> : <InboxScreen {...props} />}
      </View>
    </View>
  );
}
