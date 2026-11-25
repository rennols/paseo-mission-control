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
import { FONT, tint } from "./parts";
import { QueueScreen } from "./queue-screen";

type Tab = "live" | "queue" | "inbox";

export function MissionControlScreen(props: PluginScreenProps) {
  const { theme, layout, params } = props;
  const initial: Tab = params.tab === "queue" || params.tab === "inbox" ? params.tab : "live";
  const [tab, setTab] = useState<Tab>(initial);
  const [counts, setCounts] = useState<{ queued: number; review: number } | null>(null);
  useSubscription(workCountWatch, {}, setCounts);

  const tabs: { key: Tab; label: string; count: number | null }[] = [
    { key: "live", label: "Live", count: null },
    { key: "queue", label: "Queue", count: counts ? counts.queued : null },
    { key: "inbox", label: "Review inbox", count: counts ? counts.review : null },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: layout.compact ? 8 : 12,
          paddingVertical: 6,
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
              accessibilityLabel={item.count === null ? item.label : `${item.label}, ${item.count}`}
              onPress={() => setTab(item.key)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                minHeight: 32,
                paddingHorizontal: 11,
                borderRadius: 7,
                backgroundColor: active ? theme.colors.surface2 : pressed ? tint(theme.colors.foreground, 0.06) : "transparent",
              })}
            >
              <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: FONT.body, fontWeight: active ? "600" : "500" }}>
                {item.label}
              </Text>
              {item.count === null ? null : (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, fontVariant: ["tabular-nums"] }}>{item.count}</Text>
              )}
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
