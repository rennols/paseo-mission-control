/**
 * Mission Control, Live tab: the agent tree with activity lanes, and the Needs you column.
 * Renders what the server pushes on `live.watch`; it never polls and holds no logic of its own.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { STATUS_LABEL, liveWatch, type AgentRow, type AgentStatus, type LiveSnapshot } from "../shared/live";
import { Lane, LaneLegend } from "./lane";
import { buildGroups } from "./ui-format";
import { NeedsCard } from "./needs-card";
import { EmptyNote, FONT, ScreenState, SectionHeader, StatusPill, Toggle, formatElapsed, pagePadding, statusColor, tint } from "./parts";

const COUNTED: AgentStatus[] = ["working", "waiting", "stuck", "idle"];

/** Fixed widths so status, changes and time line up from row to row on a desk. */
const COL = { name: 200, status: 116, right: 64 } as const;

function AgentRowView({
  theme,
  compact,
  row,
  depth,
  now,
  onOpen,
}: {
  theme: PluginTheme;
  compact: boolean;
  row: AgentRow;
  depth: number;
  now: number;
  onOpen: (() => void) | null;
}) {
  const muted = { color: theme.colors.foregroundMuted, fontSize: FONT.meta };
  const num = { ...muted, fontVariant: ["tabular-nums" as const], textAlign: "right" as const };
  const meta = [row.provider, row.branch].filter(Boolean).join(" · ");
  const lines = (row.linesAdded ?? 0) + (row.linesRemoved ?? 0) > 0 ? `+${row.linesAdded ?? 0} −${row.linesRemoved ?? 0}` : null;
  const elapsed = formatElapsed(now - row.since);
  const label = `${row.title}, ${STATUS_LABEL[row.status]}, ${elapsed}${lines ? `, ${lines} lines` : ""}${row.latestActivity ? `, ${row.latestActivity}` : ""}`;
  const lane = <Lane theme={theme} segments={row.lane} marks={row.marks} now={now} description={row.laneDescription} />;
  const title = (
    <Text style={{ color: theme.colors.foreground, fontSize: FONT.row, fontWeight: "500", flexShrink: 1 }} numberOfLines={1}>
      {row.title}
    </Text>
  );
  const branch = depth > 0 ? <Text style={[muted, { width: 14 }]}>↳</Text> : null;
  return (
    <Pressable
      accessibilityRole={onOpen ? "button" : undefined}
      accessibilityLabel={label}
      accessibilityHint={onOpen ? "Opens the agent's chat" : undefined}
      onPress={onOpen ?? undefined}
      disabled={!onOpen}
      style={({ pressed }) => ({
        paddingVertical: 10,
        paddingRight: 8,
        paddingLeft: 8 + depth * 16,
        gap: 6,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: pressed ? tint(theme.colors.foreground, 0.05) : "transparent",
      })}
    >
      {compact ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {branch}
            {title}
            <Text style={[num, { marginLeft: "auto", flexShrink: 0 }]} numberOfLines={1}>
              {elapsed}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatusPill theme={theme} status={row.status} />
            {meta ? (
              <Text style={[muted, { flexShrink: 1 }]} numberOfLines={1}>
                {meta}
              </Text>
            ) : null}
            {lines ? <Text style={[num, { marginLeft: "auto" }]}>{lines}</Text> : null}
          </View>
          <View style={{ flexDirection: "row" }}>{lane}</View>
        </>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ width: COL.name - depth * 16, flexDirection: "row", alignItems: "center", gap: 4 }}>
            {branch}
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              {title}
              {meta ? (
                <Text style={muted} numberOfLines={1}>
                  {meta}
                </Text>
              ) : null}
            </View>
          </View>
          {lane}
          <View style={{ width: COL.status }}>
            <StatusPill theme={theme} status={row.status} />
          </View>
          <View style={{ width: COL.right, alignItems: "flex-end", gap: 2 }}>
            <Text style={[num, { color: lines ? theme.colors.foreground : theme.colors.foregroundMuted }]} accessibilityLabel={lines ?? "No file changes"}>
              {lines ?? "—"}
            </Text>
            <Text style={num} numberOfLines={1}>
              {elapsed}
            </Text>
          </View>
        </View>
      )}
      {row.latestActivity ? (
        <Text style={[muted, { paddingLeft: compact ? 0 : depth > 0 ? 18 : 0 }]} numberOfLines={compact ? 2 : 1}>
          {row.latestActivity}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** One status count at the top of Live, in the mockup's stat-box style. Zero counts are greyed. */
function Stat({ theme, status, count, compact }: { theme: PluginTheme; status: AgentStatus; count: number; compact: boolean }) {
  const zero = count === 0;
  return (
    <View
      accessible
      accessibilityLabel={`${STATUS_LABEL[status]}: ${count}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: compact ? 10 : 12,
        paddingVertical: compact ? 4 : 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: zero ? theme.colors.border : statusColor(theme, status) }} />
      <Text style={{ color: zero ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: FONT.row, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
        {count}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.body }}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}

export function LiveScreen({ theme, layout, navigation, host }: PluginScreenProps) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [hostFilter, setHostFilter] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const subscription = useSubscription(liveWatch, {}, setSnapshot);
  const compact = layout.compact;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      top: { padding: pagePadding(compact), gap: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
      counts: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: compact ? 6 : 8 },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      body: { flex: 1, flexDirection: compact ? ("column" as const) : ("row" as const) },
      tree: { flex: 1, minWidth: 0 },
      needs: compact
        ? { gap: 8, padding: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border }
        : { width: 340, borderLeftWidth: 1, borderLeftColor: theme.colors.border },
      note: { color: theme.colors.foregroundMuted, fontSize: FONT.meta, lineHeight: 17 },
      groupHeader: { flexDirection: "row" as const, gap: 8, alignItems: "baseline" as const, paddingHorizontal: 8, paddingTop: 16, paddingBottom: 6 },
      groupName: { color: theme.colors.foreground, fontSize: FONT.body, fontWeight: "600" as const, flexShrink: 1 },
    }),
    [theme, compact],
  );

  if (!snapshot) {
    return <ScreenState theme={theme} hostLabel={host.label} error={subscription.status === "error" ? subscription.error.message : null} />;
  }

  const now = snapshot.generatedAt;
  const agents = hostFilter ? snapshot.agents.filter((agent) => agent.serverId === hostFilter) : snapshot.agents;
  const counts = new Map<AgentStatus, number>();
  for (const agent of agents) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  const closedCount = agents.filter((agent) => agent.status === "closed").length;
  const groups = buildGroups(showClosed ? agents : agents.filter((agent) => agent.status !== "closed"));
  const openNeeds = snapshot.needs.filter((item) => item.resolvedAt === null);
  const doneNeeds = snapshot.needs.filter((item) => item.resolvedAt !== null);
  const needsVisible = hostFilter === null || hostFilter === snapshot.self.serverId;
  const openChat = navigation
    ? (serverId: string, agentId: string) => navigation.openAgent({ agentId, serverId })
    : null;

  const needsColumn = (
    <View style={styles.needs}>
      <View style={{ padding: compact ? 0 : 16, paddingBottom: 8, gap: 2 }}>
        <SectionHeader theme={theme} title="Needs you" count={openNeeds.length} />
        <Text style={styles.note}>For agents on {snapshot.self.label}. Other hosts show their own list.</Text>
      </View>
      <ScrollView style={compact ? undefined : { flex: 1 }} contentContainerStyle={{ gap: 8, padding: compact ? 0 : 16, paddingTop: 0 }} scrollEnabled={!compact}>
        {!needsVisible ? (
          <EmptyNote theme={theme}>Open Mission Control on that host to see what it needs.</EmptyNote>
        ) : openNeeds.length === 0 ? (
          <EmptyNote theme={theme}>✓ All clear. Nothing needs you.</EmptyNote>
        ) : null}
        {needsVisible
          ? [...openNeeds, ...(showDone ? doneNeeds : [])].map((item) => (
              <NeedsCard
                key={item.id}
                theme={theme}
                item={item}
                now={now}
                onOpenChat={openChat ? (agentId) => openChat(snapshot.self.serverId, agentId) : null}
              />
            ))
          : null}
        {needsVisible && doneNeeds.length > 0 ? (
          <Toggle
            theme={theme}
            open={showDone}
            onPress={() => setShowDone(!showDone)}
            label={showDone ? "Hide what you handled" : `Handled in the last 10 min · ${doneNeeds.length}`}
          />
        ) : null}
      </ScrollView>
    </View>
  );

  const tree = (
    <View style={{ padding: compact ? 12 : 16, paddingTop: compact ? 0 : 8 }}>
      {groups.length === 0 ? (
        <View style={{ padding: 8 }}>
          <EmptyNote theme={theme}>
            {closedCount > 0
              ? `No open agents on ${hostFilter ? "this host" : "your hosts"}.`
              : `No agents on ${hostFilter ? "this host" : "your hosts"} yet. Agents you start in Paseo show up here.`}
          </EmptyNote>
        </View>
      ) : (
        groups.map((group) => (
          <View key={group.key}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupName} numberOfLines={1}>
                {group.name}
              </Text>
              <Text style={[styles.note, { flexShrink: 0 }]} numberOfLines={1}>
                {group.hostLabel}
                {group.watched ? "" : " · read only"}
              </Text>
              <Text style={[styles.note, { marginLeft: "auto", flexShrink: 0 }]} numberOfLines={1}>
                {group.rows.length} agent{group.rows.length === 1 ? "" : "s"}
              </Text>
            </View>
            {group.rows.map(({ row, depth }) => (
              <AgentRowView
                key={`${row.serverId}:${row.id}`}
                theme={theme}
                compact={compact}
                row={row}
                depth={depth}
                now={now}
                onOpen={openChat ? () => openChat(row.serverId, row.id) : null}
              />
            ))}
          </View>
        ))
      )}
      {closedCount > 0 ? (
        <View style={{ paddingHorizontal: 8, paddingVertical: 8 }}>
          <Toggle
            theme={theme}
            open={showClosed}
            onPress={() => setShowClosed(!showClosed)}
            label={showClosed ? "Hide closed agents" : `Show closed agents · ${closedCount}`}
          />
        </View>
      ) : null}
      {groups.length > 0 ? <LaneLegend theme={theme} /> : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <View style={styles.counts}>
          {COUNTED.map((status) => (
            <Stat key={status} theme={theme} status={status} count={counts.get(status) ?? 0} compact={compact} />
          ))}
        </View>
        {snapshot.hosts
          .filter((item) => item.error)
          .map((item) => (
            <Text key={`error-${item.serverId}`} style={{ color: theme.colors.statusDanger, fontSize: FONT.meta }} accessibilityRole="alert">
              ⚠ {item.label}: {item.error}
            </Text>
          ))}
        {snapshot.hosts.length > 1 ? (
          <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Host filter">
            {[{ serverId: null as string | null, label: "All hosts", status: "online" }, ...snapshot.hosts].map((option) => {
              const active = hostFilter === option.serverId;
              return (
                <Pressable
                  key={option.serverId ?? "all"}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => setHostFilter(option.serverId)}
                  style={{
                    minHeight: 28,
                    justifyContent: "center",
                    paddingHorizontal: 10,
                    borderRadius: 7,
                    borderWidth: 1,
                    borderColor: active ? theme.colors.foregroundMuted : theme.colors.border,
                    backgroundColor: active ? theme.colors.surface2 : "transparent",
                  }}
                >
                  <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: FONT.meta, fontWeight: active ? "600" : "400" }}>
                    {active ? "✓ " : ""}
                    {option.label}
                    {option.status !== "online" ? ` (${option.status})` : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
      {compact ? (
        <ScrollView style={{ flex: 1 }}>
          {needsColumn}
          {tree}
        </ScrollView>
      ) : (
        <View style={styles.body}>
          <ScrollView style={styles.tree}>{tree}</ScrollView>
          {needsColumn}
        </View>
      )}
    </View>
  );
}
