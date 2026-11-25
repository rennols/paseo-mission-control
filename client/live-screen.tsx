/**
 * Mission Control, Live tab: the agent tree with activity lanes, and the Needs you column.
 * Renders what the server pushes on `live.watch`; it never polls and holds no logic of its own.
 * Queue and Review inbox tabs arrive with P1.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { STATUS_LABEL, liveWatch, type AgentRow, type AgentStatus, type LiveSnapshot } from "../shared/live";
import { Lane } from "./lane";
import { NeedsCard } from "./needs-card";
import { Pill, StatusPill, formatElapsed, statusColor } from "./parts";

const COUNTED: AgentStatus[] = ["working", "waiting", "stuck", "idle"];

interface Group {
  key: string;
  name: string;
  hostLabel: string;
  watched: boolean;
  rows: { row: AgentRow; depth: number }[];
}

/** Workspace groups, workers nested under the agent that started them (by parentAgentId). */
export function buildGroups(agents: readonly AgentRow[]): Group[] {
  const byId = new Map(agents.map((agent) => [`${agent.serverId}:${agent.id}`, agent]));
  const children = new Map<string, AgentRow[]>();
  const roots: AgentRow[] = [];
  for (const agent of agents) {
    const parentKey = agent.parentAgentId ? `${agent.serverId}:${agent.parentAgentId}` : null;
    if (parentKey && byId.has(parentKey)) {
      const list = children.get(parentKey) ?? [];
      list.push(agent);
      children.set(parentKey, list);
    } else {
      roots.push(agent);
    }
  }
  const order = (a: AgentRow, b: AgentRow) => a.title.localeCompare(b.title);
  const groups = new Map<string, Group>();
  for (const root of roots.sort(order)) {
    const group = groups.get(root.workspaceKey) ?? {
      key: root.workspaceKey,
      name: root.workspaceName,
      hostLabel: root.hostLabel,
      watched: root.watched,
      rows: [],
    };
    groups.set(root.workspaceKey, group);
    const visit = (agent: AgentRow, depth: number, seen: Set<string>) => {
      const key = `${agent.serverId}:${agent.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      group.rows.push({ row: agent, depth });
      for (const child of (children.get(key) ?? []).sort(order)) visit(child, depth + 1, seen);
    };
    visit(root, 0, new Set());
  }
  return [...groups.values()].sort((a, b) => a.hostLabel.localeCompare(b.hostLabel) || a.name.localeCompare(b.name));
}

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
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const meta = [row.provider, row.branch].filter(Boolean).join(" · ");
  const lines =
    row.linesAdded !== null || row.linesRemoved !== null ? `+${row.linesAdded ?? 0} −${row.linesRemoved ?? 0}` : null;
  const label = `${row.title}, ${STATUS_LABEL[row.status]}, ${formatElapsed(now - row.since)}${row.latestActivity ? `, ${row.latestActivity}` : ""}`;
  const lane = <Lane theme={theme} segments={row.lane} marks={row.marks} now={now} description={row.laneDescription} />;
  return (
    <Pressable
      accessibilityRole={onOpen ? "button" : undefined}
      accessibilityLabel={label}
      accessibilityHint={onOpen ? "Opens the agent's chat" : undefined}
      onPress={onOpen ?? undefined}
      disabled={!onOpen}
      style={{
        paddingVertical: 8,
        paddingRight: 8,
        paddingLeft: 8 + depth * 16,
        gap: 4,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {depth > 0 ? <Text style={muted}>↳</Text> : null}
        <View style={{ flexShrink: 1, flexGrow: compact ? 1 : 0, width: compact ? undefined : 200 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "500" }} numberOfLines={1}>
            {row.title}
          </Text>
          {meta ? (
            <Text style={muted} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        {compact ? null : lane}
        <StatusPill theme={theme} status={row.status} />
        {lines ? <Text style={[muted, { minWidth: 64, textAlign: "right" }]}>{lines}</Text> : null}
        <Text style={[muted, { minWidth: 44, textAlign: "right" }]}>{formatElapsed(now - row.since)}</Text>
      </View>
      {compact ? <View style={{ flexDirection: "row" }}>{lane}</View> : null}
      {row.latestActivity ? (
        <Text style={muted} numberOfLines={1}>
          {row.latestActivity}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function LiveScreen({ theme, layout, navigation, host }: PluginScreenProps) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [hostFilter, setHostFilter] = useState<string | null>(null);
  const subscription = useSubscription(liveWatch, {}, setSnapshot);
  const compact = layout.compact;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      top: { padding: compact ? 12 : 20, gap: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
      counts: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      body: { flex: 1, flexDirection: compact ? ("column" as const) : ("row" as const) },
      tree: { flex: 1, minWidth: 0 },
      needs: compact
        ? { gap: 8, padding: 12 }
        : { width: 360, borderLeftWidth: 1, borderLeftColor: theme.colors.border },
      sectionTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      note: { color: theme.colors.foregroundMuted, fontSize: 12 },
      groupHeader: { flexDirection: "row" as const, gap: 8, alignItems: "baseline" as const, paddingHorizontal: 8, paddingTop: 14, paddingBottom: 6 },
      groupName: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      center: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, padding: 24, gap: 8 },
    }),
    [theme, compact],
  );

  if (!snapshot) {
    return (
      <View style={[styles.screen, styles.center]}>
        {subscription.status === "error" ? (
          <>
            <Text style={{ color: theme.colors.statusDanger }}>Mission Control could not connect to {host.label}.</Text>
            <Text style={styles.note}>{subscription.error.message}</Text>
          </>
        ) : (
          <ActivityIndicator color={theme.colors.foregroundMuted} />
        )}
      </View>
    );
  }

  const now = snapshot.generatedAt;
  const agents = hostFilter ? snapshot.agents.filter((agent) => agent.serverId === hostFilter) : snapshot.agents;
  const counts = new Map<AgentStatus, number>();
  for (const agent of agents) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  const groups = buildGroups(agents);
  const openNeeds = snapshot.needs.filter((item) => item.resolvedAt === null);
  const needsVisible = hostFilter === null || hostFilter === snapshot.self.serverId;
  const openChat = navigation
    ? (serverId: string, agentId: string) => navigation.openAgent({ agentId, serverId })
    : null;

  const needsColumn = (
    <View style={styles.needs}>
      <View style={{ padding: compact ? 0 : 16, paddingBottom: 8, gap: 2 }}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          Needs you · {openNeeds.length}
        </Text>
        <Text style={styles.note}>For agents on {snapshot.self.label}. Other hosts show their own list.</Text>
      </View>
      <ScrollView style={compact ? undefined : { flex: 1 }} contentContainerStyle={{ gap: 8, padding: compact ? 0 : 16, paddingTop: 0 }} scrollEnabled={!compact}>
        {!needsVisible ? (
          <Text style={styles.note}>Open Mission Control on that host to see what it needs.</Text>
        ) : snapshot.needs.length === 0 ? (
          <Text style={styles.note}>All clear. Nothing needs you.</Text>
        ) : (
          snapshot.needs.map((item) => (
            <NeedsCard
              key={item.id}
              theme={theme}
              item={item}
              now={now}
              onOpenChat={openChat ? (agentId) => openChat(snapshot.self.serverId, agentId) : null}
            />
          ))
        )}
      </ScrollView>
    </View>
  );

  const tree = (
    <View style={{ padding: compact ? 12 : 16, paddingTop: compact ? 0 : 8 }}>
      {groups.length === 0 ? (
        <Text style={[styles.note, { padding: 8 }]}>No agents running on {hostFilter ? "this host" : "your hosts"}.</Text>
      ) : (
        groups.map((group) => (
          <View key={group.key}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupName} numberOfLines={1}>
                {group.name}
              </Text>
              <Text style={styles.note} numberOfLines={1}>
                {group.hostLabel}
                {group.watched ? "" : " · read only"}
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
    </View>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <View style={styles.counts}>
          {COUNTED.map((status) => (
            <Pill key={status} theme={theme} label={`${STATUS_LABEL[status]} ${counts.get(status) ?? 0}`} color={statusColor(theme, status)} />
          ))}
        </View>
        {snapshot.hosts
          .filter((item) => item.error)
          .map((item) => (
            <Text key={`error-${item.serverId}`} style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
              {item.label}: {item.error}
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
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: active ? theme.colors.accent : theme.colors.border,
                    backgroundColor: active ? theme.colors.surface2 : "transparent",
                  }}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
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
