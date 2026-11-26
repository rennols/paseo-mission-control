/**
 * The Mission Control screen: four tabs, Live, Office, Queue and Review inbox (PRD: Mission
 * Control screen; Office added 2026-11-26). The tab labels carry the queued and ready-for-review counts the server pushes on
 * `work.count.watch`. Open on a tab with the screen param `tab` ("live", "office", "queue" or "inbox").
 */
import { useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { needsCountWatch } from "../shared/live";
import { workCountWatch } from "../shared/queue";
import { InboxScreen } from "./inbox-screen";
import { LiveScreen } from "./live-screen";
import { OfficeScreen } from "./office-screen";
import { FONT, Pill, tint } from "./parts";
import { QueueScreen } from "./queue-screen";

type Tab = "live" | "office" | "queue" | "inbox";

export function MissionControlScreen(props: PluginScreenProps) {
  const { theme, layout, params } = props;
  const initial: Tab = params.tab === "office" || params.tab === "queue" || params.tab === "inbox" ? params.tab : "live";
  const [tab, setTab] = useState<Tab>(initial);
  const [counts, setCounts] = useState<{ queued: number; review: number } | null>(null);
  useSubscription(workCountWatch, {}, setCounts);
  const [needsOpen, setNeedsOpen] = useState<number | null>(null);
  useSubscription(needsCountWatch, {}, (event) => setNeedsOpen(event.open));

  // Each tab carries the count that asks for you: Live the open Needs you cards (so they show from
  // the Queue or Review tab too), Queue the waiting tasks, Review inbox the worktrees to review.
  const tabs: { key: Tab; label: string; count: number | null; spoken: string }[] = [
    { key: "live", label: "Live", count: needsOpen, spoken: "need you" },
    { key: "office", label: "Office", count: null, spoken: "" },
    { key: "queue", label: "Queue", count: counts ? counts.queued : null, spoken: "queued" },
    // "Review" on a phone, so the three tabs and the need-you badge fit one line at 360 px.
    { key: "inbox", label: layout.compact ? "Review" : "Review inbox", count: counts ? counts.review : null, spoken: "to review" },
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
              accessibilityLabel={item.count === null ? item.label : `${item.label}, ${item.count} ${item.spoken}`}
              onPress={() => setTab(item.key)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                minHeight: 32,
                paddingHorizontal: layout.compact ? 9 : 11,
                borderRadius: 7,
                backgroundColor: active ? theme.colors.surface2 : pressed ? tint(theme.colors.foreground, 0.06) : "transparent",
              })}
            >
              <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: FONT.body, fontWeight: active ? "600" : "500" }}>
                {item.label}
              </Text>
              {item.count === null || (item.key === "live" && item.count === 0) ? null : item.key === "live" ? (
                <Pill theme={theme} square label={`${item.count} need you`} color={theme.colors.statusWarning} />
              ) : (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, fontVariant: ["tabular-nums"] }}>{item.count}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
      <View style={{ flex: 1 }}>
        {tab === "live" ? <LiveScreen {...props} /> : tab === "office" ? <OfficeScreen {...props} /> : tab === "queue" ? <QueueScreen {...props} onOpenInbox={() => setTab("inbox")} /> : <InboxScreen {...props} />}
      </View>
    </View>
  );
}
