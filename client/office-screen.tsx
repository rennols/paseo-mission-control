/**
 * Mission Control, Office tab: each top-level agent is a supervisor with a room, and the agents it
 * hands work to sit at desks in that room. Paseo subagents and in-agent subagents (Claude's Task
 * tool) both get a desk. Each desk shows what was asked, what it is doing now, and a state in
 * words with an icon and a pose, so colour is never the only signal.
 *
 * Renders what the server pushes on `live.watch` (the same feed as the Live tab); it never polls.
 * Motion: a working desk's screen flickers and a waiting engineer waves; a new desk slides in when
 * work is handed off. With the system's reduced motion setting on, nothing moves.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, Text, View } from "react-native";
import { liveWatch, type LiveSnapshot } from "../shared/live";
import { DESK_STATE, buildRooms, isFolded, roomSummary, type Desk, type DeskState, type Room } from "./office-format";
import { EmptyNote, FONT, MONO, ScreenState, Toggle, formatElapsed, pagePadding, tint } from "./parts";

/** A handoff counts as new for this long: the slip shows on the supervisor's desk. */
const HANDOFF_MS = 60_000;

function stateColor(theme: PluginTheme, state: DeskState): string {
  switch (state) {
    case "working":
      return theme.colors.accent;
    case "waiting":
      return theme.colors.statusWarning;
    case "stuck":
    case "error":
      return theme.colors.statusDanger;
    case "done":
      return theme.colors.statusSuccess;
    default:
      return theme.colors.foregroundMuted;
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((value) => live && setReduced(value))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.("reduceMotionChanged", (value: boolean) => setReduced(value));
    return () => {
      live = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

/** A looping 0→1→0 value, or a constant when motion is off. */
function useLoop(active: boolean, duration: number): Animated.Value {
  const value = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (!active) {
      value.setValue(0.5);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(value, { toValue: 0, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, duration, value]);
  return value;
}

/** The little desk: a desktop, a monitor and a person, posed by state. Decorative only. */
function Scene({ theme, state, motion, small }: { theme: PluginTheme; state: DeskState; motion: boolean; small: boolean }) {
  const color = stateColor(theme, state);
  const away = state === "done" || state === "closed" || state === "stopped";
  const flicker = useLoop(motion && state === "working", 600);
  const wave = useLoop(motion && state === "waiting", 450);
  const scale = small ? 0.8 : 1;
  const person = away ? theme.colors.border : state === "idle" ? theme.colors.foregroundMuted : color;
  const headDrop = state === "stuck" || state === "error" ? 5 : 0;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 64 * scale, height: 46 * scale, transform: [{ scale }], transformOrigin: "left top" as never }}
    >
      {/* Person */}
      <View style={{ position: "absolute", left: 6, bottom: 8, width: 20, alignItems: "center", opacity: away ? 0.5 : 1 }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: person, transform: [{ translateY: headDrop }, { translateX: headDrop ? 3 : 0 }] }} />
        <View style={{ width: 20, height: 13, marginTop: 2, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomLeftRadius: 2, borderBottomRightRadius: 2, backgroundColor: person }} />
        {state === "waiting" ? (
          <Animated.View
            style={{
              position: "absolute",
              left: -5,
              top: -8,
              width: 4,
              height: 15,
              borderRadius: 2,
              backgroundColor: person,
              transform: [{ rotate: wave.interpolate({ inputRange: [0, 1], outputRange: ["-4deg", "-22deg"] }) }],
            }}
          />
        ) : null}
      </View>
      {/* Monitor */}
      <View style={{ position: "absolute", left: 30, bottom: 8, width: 28, height: 20, borderRadius: 3, borderWidth: 2, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0, padding: 3, gap: 2, overflow: "hidden" }}>
        {[0, 1, 2].map((line) => (
          <Animated.View
            key={line}
            style={{
              height: 2,
              width: line === 1 ? "60%" : "85%",
              backgroundColor: away || state === "idle" ? theme.colors.border : color,
              opacity: state === "working" ? flicker.interpolate({ inputRange: [0, 1], outputRange: line === 1 ? [0.9, 0.3] : [0.3, 0.9] }) : 0.5,
            }}
          />
        ))}
      </View>
      {/* Desktop */}
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 2, height: 5, borderRadius: 2, backgroundColor: tint(theme.colors.foregroundMuted, 0.45) }} />
    </View>
  );
}

function StateLine({ theme, state }: { theme: PluginTheme; state: DeskState }) {
  const { icon, label } = DESK_STATE[state];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View style={{ minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, borderWidth: 1, borderColor: stateColor(theme, state), alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: stateColor(theme, state), fontSize: 11, fontWeight: "700", fontFamily: MONO, lineHeight: 14 }}>{icon}</Text>
      </View>
      <Text style={{ color: theme.colors.foreground, fontSize: FONT.meta, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

/** Slides in (or just appears, with reduced motion) the first time this client sees the desk. */
function Arrival({ fresh, motion, children }: { fresh: boolean; motion: boolean; children: React.ReactNode }) {
  const value = useRef(new Animated.Value(fresh && motion ? 0 : 1)).current;
  useEffect(() => {
    if (!fresh || !motion) return;
    Animated.timing(value, { toValue: 1, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [fresh, motion, value]);
  return (
    <Animated.View style={{ opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }) }] }}>
      {children}
    </Animated.View>
  );
}

function DeskCard({
  theme,
  compact,
  desk,
  now,
  fresh,
  motion,
  onOpen,
}: {
  theme: PluginTheme;
  compact: boolean;
  desk: Desk;
  now: number;
  fresh: boolean;
  motion: boolean;
  onOpen: (() => void) | null;
}) {
  const inAgent = desk.kind === "in-agent";
  const justArrived = now - desk.startedAt < HANDOFF_MS && desk.state === "working";
  const label = [
    inAgent ? `In-agent subagent ${desk.title}` : `Subagent ${desk.title}`,
    DESK_STATE[desk.state].label,
    desk.ask ? `asked: ${desk.ask}` : null,
    desk.now ? `now: ${desk.now}` : null,
    desk.reportsTo ? `reports to ${desk.reportsTo}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Arrival fresh={fresh} motion={motion}>
      <Pressable
        accessibilityRole={onOpen ? "button" : undefined}
        accessibilityLabel={label}
        accessibilityHint={onOpen ? (inAgent ? "Opens the supervisor's chat" : "Opens the agent's chat") : undefined}
        onPress={onOpen ?? undefined}
        disabled={!onOpen}
        style={({ pressed }) => ({
          gap: 5,
          padding: 8,
          minHeight: 150,
          borderRadius: 8,
          borderWidth: 1,
          borderStyle: inAgent ? "dashed" : "solid",
          borderColor: desk.state === "waiting" || desk.state === "stuck" ? stateColor(theme, desk.state) : theme.colors.border,
          backgroundColor: pressed ? tint(theme.colors.foreground, 0.05) : theme.colors.surface1,
        })}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
          <Scene theme={theme} state={desk.state} motion={motion} small={compact} />
          {justArrived ? (
            <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 }}>NEW</Text>
          ) : null}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600", letterSpacing: 0.5 }} numberOfLines={1}>
          {inAgent ? "IN-AGENT" : "SUBAGENT"}
          {desk.reportsTo ? ` · FOR ${desk.reportsTo.toUpperCase()}` : ""}
        </Text>
        <Text style={{ color: theme.colors.foreground, fontSize: FONT.body, fontWeight: "600" }} numberOfLines={2}>
          {desk.title}
        </Text>
        <StateLine theme={theme} state={desk.state} />
        {desk.ask ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }} numberOfLines={2}>
            Asked: <Text style={{ color: theme.colors.foreground }}>{desk.ask}</Text>
          </Text>
        ) : null}
        {desk.now ? (
          <Text style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO }} numberOfLines={1}>
            {desk.now}
          </Text>
        ) : null}
      </Pressable>
    </Arrival>
  );
}

function RoomView({
  theme,
  compact,
  room,
  now,
  seen,
  motion,
  openChat,
  showDone,
}: {
  theme: PluginTheme;
  compact: boolean;
  room: Room;
  now: number;
  seen: ReadonlySet<string> | null;
  motion: boolean;
  openChat: ((serverId: string, agentId: string) => void) | null;
  showDone: boolean;
}) {
  const { supervisor } = room;
  const folded = room.desks.filter((desk) => isFolded(desk, now));
  const desks = showDone ? room.desks : room.desks.filter((desk) => !isFolded(desk, now));
  const handoffs = room.desks.filter((desk) => now - desk.startedAt < HANDOFF_MS && desk.state === "working" && desk.reportsTo === null);
  const latest = handoffs.sort((a, b) => b.startedAt - a.startedAt)[0];
  const openSupervisor = openChat ? () => openChat(supervisor.serverId, supervisor.id) : null;
  const summary = roomSummary(room);
  return (
    <View
      accessibilityRole="summary"
      style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: compact ? 8 : 10, gap: 8, backgroundColor: theme.colors.surface0 }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: FONT.title, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
          {supervisor.workspaceName}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, fontFamily: MONO, flexShrink: 1 }} numberOfLines={1}>
          {[supervisor.hostLabel, supervisor.branch].filter(Boolean).join(" · ")}
          {supervisor.watched ? "" : " · read only"}
        </Text>
      </View>
      <Pressable
        accessibilityRole={openSupervisor ? "button" : undefined}
        accessibilityLabel={`Supervisor ${supervisor.title}, ${DESK_STATE[room.supervisorState].label}${room.supervisorNow ? `, ${room.supervisorNow}` : ""}. Team: ${summary}.`}
        accessibilityHint={openSupervisor ? "Opens the agent's chat" : undefined}
        onPress={openSupervisor ?? undefined}
        disabled={!openSupervisor}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          padding: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: room.supervisorState === "waiting" || room.supervisorState === "stuck" ? stateColor(theme, room.supervisorState) : theme.colors.border,
          backgroundColor: pressed ? tint(theme.colors.foreground, 0.05) : theme.colors.surface1,
        })}
      >
        <Scene theme={theme} state={room.supervisorState} motion={motion} small={false} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600", letterSpacing: 0.5 }}>SUPERVISOR · {supervisor.provider.toUpperCase()}</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: FONT.row, fontWeight: "600" }} numberOfLines={1}>
            {supervisor.title}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <StateLine theme={theme} state={room.supervisorState} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, fontVariant: ["tabular-nums"] }}>{formatElapsed(now - supervisor.since)}</Text>
          </View>
          {room.supervisorNow ? (
            <Text style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO }} numberOfLines={1}>
              {room.supervisorNow}
            </Text>
          ) : null}
          {latest ? (
            <View style={{ alignSelf: "flex-start", maxWidth: "100%", flexDirection: "row", gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: theme.colors.accent, backgroundColor: tint(theme.colors.accent, 0.08) }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 11, flexShrink: 1 }} numberOfLines={1}>
                ✉ Handed to {latest.title}
                {latest.ask ? `: ${latest.ask}` : ""}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }}>Team: {summary}</Text>
      {desks.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {desks.map((desk) => (
            <View key={desk.key} style={compact ? { flexBasis: "47%", flexGrow: 1, minWidth: 0 } : { width: 188 }}>
              <DeskCard
                theme={theme}
                compact={compact}
                desk={desk}
                now={now}
                fresh={seen !== null && !seen.has(desk.key)}
                motion={motion}
                onOpen={openChat && desk.open ? () => openChat(desk.open!.serverId, desk.open!.agentId) : null}
              />
            </View>
          ))}
        </View>
      ) : null}
      {folded.length > 0 && !showDone ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }}>
          ✓ {folded.length} finished {folded.length === 1 ? "engineer has" : "engineers have"} left their desk
        </Text>
      ) : null}
    </View>
  );
}

export function OfficeScreen({ theme, layout, navigation, host }: PluginScreenProps) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const subscription = useSubscription(liveWatch, {}, setSnapshot);
  const compact = layout.compact;
  const reduced = useReducedMotion();
  const motion = !reduced;

  const rooms = useMemo(() => (snapshot ? buildRooms(snapshot.agents, showClosed) : []), [snapshot, showClosed]);
  // Desks this client has already shown, so only a real handoff slides in (not the first render).
  const seenRef = useRef<Set<string> | null>(null);
  const seen = seenRef.current;
  useEffect(() => {
    if (!snapshot) return;
    const next = new Set(seenRef.current ?? []);
    for (const room of rooms) for (const desk of room.desks) next.add(desk.key);
    seenRef.current = next;
  }, [rooms, snapshot]);

  if (!snapshot) {
    return <ScreenState theme={theme} hostLabel={host.label} error={subscription.status === "error" ? subscription.error.message : null} />;
  }
  const now = snapshot.generatedAt;
  const closedCount = snapshot.agents.filter((agent) => agent.status === "closed").length;
  const anyFinished = rooms.some((room) => room.desks.some((desk) => isFolded(desk, now)));
  const openChat = navigation ? (serverId: string, agentId: string) => navigation.openAgent({ agentId, serverId }) : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pagePadding(compact), gap: 12 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, lineHeight: 17 }}>
        Each agent you start is a supervisor. The agents and in-agent subagents it hands work to sit at desks in its room. Tap a desk to open its chat. Approvals stay in Needs you on the Live tab.
      </Text>
      {rooms.length === 0 ? (
        <EmptyNote theme={theme}>No agents yet. Agents you start in Paseo get a room here.</EmptyNote>
      ) : (
        rooms.map((room) => (
          <RoomView key={room.key} theme={theme} compact={compact} room={room} now={now} seen={seen} motion={motion} openChat={openChat} showDone={showDone} />
        ))
      )}
      <View style={{ gap: 6 }}>
        {anyFinished ? (
          <Toggle theme={theme} open={showDone} onPress={() => setShowDone(!showDone)} label={showDone ? "Hide finished engineers" : "Show finished engineers"} />
        ) : null}
        {closedCount > 0 ? (
          <Toggle theme={theme} open={showClosed} onPress={() => setShowClosed(!showClosed)} label={showClosed ? "Hide closed agents" : `Show closed agents · ${closedCount}`} />
        ) : null}
      </View>
    </ScrollView>
  );
}
