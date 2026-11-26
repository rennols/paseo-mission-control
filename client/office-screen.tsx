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
import {
  DESK_STATE,
  buildRooms,
  deskTime,
  isFinished,
  isFolded,
  isQuiet,
  officeCounts,
  roomMeta,
  roomSummary,
  type Desk,
  type DeskState,
  type Room,
} from "./office-format";
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

function StateLine({ theme, state, time }: { theme: PluginTheme; state: DeskState; time?: string | null }) {
  const { icon, label } = DESK_STATE[state];
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
      <View style={{ minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, borderWidth: 1, borderColor: stateColor(theme, state), alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: stateColor(theme, state), fontSize: 11, fontWeight: "700", fontFamily: MONO, lineHeight: 14 }}>{icon}</Text>
      </View>
      <Text style={{ color: theme.colors.foreground, fontSize: FONT.meta, fontWeight: "600" }}>{label}</Text>
      {time ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, fontVariant: ["tabular-nums"] }}>{time}</Text> : null}
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


const KIND_TAG = { color: undefined as string | undefined, fontSize: 10, fontWeight: "700" as const, letterSpacing: 0.6 };

function DeskCard({
  theme,
  compact,
  desk,
  now,
  fresh,
  motion,
  onOpen,
  onAnswer,
}: {
  theme: PluginTheme;
  compact: boolean;
  desk: Desk;
  now: number;
  fresh: boolean;
  motion: boolean;
  onOpen: (() => void) | null;
  /** Switches to Live, where Needs you holds the request. */
  onAnswer: (() => void) | null;
}) {
  const inAgent = desk.kind === "in-agent";
  const finished = isFinished(desk);
  const justArrived = now - desk.startedAt < HANDOFF_MS && desk.state === "working";
  const asking = desk.state === "waiting" || desk.state === "stuck" || desk.state === "error";
  const time = deskTime(desk, now);
  const tag = inAgent ? `IN-AGENT${desk.role ? ` · ${desk.role.toUpperCase()}` : ""}` : "SUBAGENT";
  // An in-agent desk is already named by its task, so the "Asked" line would repeat it.
  const ask = desk.ask && desk.ask !== desk.title ? desk.ask : null;
  const label = [
    inAgent ? `In-agent subagent${desk.role ? ` ${desk.role}` : ""}: ${desk.title}` : `Subagent ${desk.title}`,
    DESK_STATE[desk.state].label,
    time,
    ask ? `asked: ${ask}` : null,
    desk.now ? `now: ${desk.now}` : null,
    desk.reportsTo ? `works for ${desk.reportsTo}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const muted = theme.colors.foregroundMuted;
  return (
    <Arrival fresh={fresh} motion={motion}>
      <Pressable
        accessibilityRole={onOpen ? "button" : undefined}
        accessibilityLabel={label}
        accessibilityHint={onOpen ? (inAgent ? "Opens the supervisor's chat" : "Opens the agent's chat") : undefined}
        onPress={onOpen ?? undefined}
        disabled={!onOpen}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
          // A phone gets Paseo-style rows (desk on the left, words on the right); a desk gets cards.
          flexDirection: compact ? "row" : "column",
          alignItems: compact ? "flex-start" : "stretch",
          gap: compact ? 10 : 6,
          padding: compact ? 8 : 10,
          minHeight: compact ? 0 : 132,
          borderRadius: 8,
          borderWidth: asking ? 1.5 : 1,
          borderStyle: inAgent && !asking ? "dashed" : "solid",
          borderColor: asking ? stateColor(theme, desk.state) : theme.colors.border,
          backgroundColor: pressed
            ? tint(theme.colors.foreground, 0.07)
            : hovered
              ? tint(theme.colors.foreground, 0.04)
              : asking
                ? tint(stateColor(theme, desk.state), 0.06)
                : finished
                  ? theme.colors.surface0
                  : theme.colors.surface1,
        })}
      >
        <View style={compact ? { paddingTop: 2 } : { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
          <Scene theme={theme} state={desk.state} motion={motion} small />
          {!compact && justArrived ? <NewTag theme={theme} /> : null}
        </View>
        <View style={{ flex: compact ? 1 : undefined, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ ...KIND_TAG, color: muted, flexShrink: 1 }} numberOfLines={1}>
              {tag}
            </Text>
            {compact && justArrived ? <NewTag theme={theme} /> : null}
          </View>
          <Text style={{ color: finished ? muted : theme.colors.foreground, fontSize: FONT.body, fontWeight: "600", lineHeight: 18 }} numberOfLines={2}>
            {desk.title}
          </Text>
          <StateLine theme={theme} state={desk.state} time={time} />
          {ask ? (
            <Text style={{ color: muted, fontSize: FONT.meta, lineHeight: 16 }} numberOfLines={2}>
              Asked: <Text style={{ color: theme.colors.foreground }}>{ask}</Text>
            </Text>
          ) : null}
          {desk.now ? (
            <Text style={{ color: desk.now.startsWith("Last: ") ? muted : theme.colors.foreground, fontSize: 11, fontFamily: desk.now.startsWith("Last: ") ? undefined : MONO }} numberOfLines={1}>
              {desk.now}
            </Text>
          ) : null}
          {desk.reportsTo ? (
            <Text style={{ color: muted, fontSize: 11 }} numberOfLines={1}>
              ↳ works for {desk.reportsTo}
            </Text>
          ) : null}
          {desk.state === "waiting" && onAnswer ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Answer in Needs you"
              accessibilityHint="Opens the Live tab, where the request waits"
              onPress={onAnswer}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                minHeight: 28,
                justifyContent: "center",
                paddingHorizontal: 10,
                marginTop: 2,
                borderRadius: 7,
                borderWidth: 1,
                borderColor: stateColor(theme, "waiting"),
                backgroundColor: pressed ? tint(stateColor(theme, "waiting"), 0.18) : tint(stateColor(theme, "waiting"), 0.1),
              })}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: FONT.meta, fontWeight: "600" }}>Answer in Needs you →</Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    </Arrival>
  );
}

function NewTag({ theme }: { theme: PluginTheme }) {
  return (
    <View style={{ paddingHorizontal: 5, borderRadius: 4, backgroundColor: tint(theme.colors.accent, 0.16) }}>
      <Text style={{ ...KIND_TAG, color: theme.colors.foreground }}>NEW</Text>
    </View>
  );
}

/** The supervisor's own desk, at the head of the room. */
function SupervisorDesk({
  theme,
  room,
  now,
  motion,
  onOpen,
}: {
  theme: PluginTheme;
  room: Room;
  now: number;
  motion: boolean;
  onOpen: (() => void) | null;
}) {
  const { supervisor } = room;
  const asking = room.supervisorState === "waiting" || room.supervisorState === "stuck" || room.supervisorState === "error";
  const handoff = room.desks
    .filter((desk) => now - desk.startedAt < HANDOFF_MS && desk.state === "working" && desk.reportsTo === null)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  return (
    <Pressable
      accessibilityRole={onOpen ? "button" : undefined}
      accessibilityLabel={`Supervisor ${supervisor.title}, ${DESK_STATE[room.supervisorState].label}${room.supervisorNow ? `, ${room.supervisorNow}` : ""}. Team: ${roomSummary(room)}.`}
      accessibilityHint={onOpen ? "Opens the agent's chat" : undefined}
      onPress={onOpen ?? undefined}
      disabled={!onOpen}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 10,
        borderRadius: 8,
        borderWidth: asking ? 1.5 : 1,
        borderColor: asking ? stateColor(theme, room.supervisorState) : theme.colors.border,
        backgroundColor: pressed
          ? tint(theme.colors.foreground, 0.07)
          : hovered
            ? tint(theme.colors.foreground, 0.04)
            : asking
              ? tint(stateColor(theme, room.supervisorState), 0.06)
              : theme.colors.surface1,
      })}
    >
      <Scene theme={theme} state={room.supervisorState} motion={motion} small={false} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={{ ...KIND_TAG, color: theme.colors.foregroundMuted }} numberOfLines={1}>
          SUPERVISOR · {supervisor.provider.toUpperCase()}
        </Text>
        <Text style={{ color: theme.colors.foreground, fontSize: FONT.row, fontWeight: "600" }} numberOfLines={1}>
          {supervisor.title}
        </Text>
        <StateLine theme={theme} state={room.supervisorState} time={formatElapsed(now - supervisor.since)} />
        {room.supervisorNow ? (
          room.supervisorNow.startsWith("Last: ") ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, lineHeight: 16 }} numberOfLines={2}>
              {room.supervisorNow}
            </Text>
          ) : (
            <Text style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO }} numberOfLines={1}>
              {room.supervisorNow}
            </Text>
          )
        ) : null}
        {handoff ? (
          <View
            style={{
              alignSelf: "flex-start",
              maxWidth: "100%",
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 11 }} numberOfLines={1}>
              ✉ Handed to {handoff.title}
              {handoff.ask ? `: ${handoff.ask}` : ""}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
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
  onCollapse,
  onAnswer,
}: {
  theme: PluginTheme;
  compact: boolean;
  room: Room;
  now: number;
  seen: ReadonlySet<string> | null;
  motion: boolean;
  openChat: ((serverId: string, agentId: string) => void) | null;
  showDone: boolean;
  onCollapse: (() => void) | null;
  onAnswer: (() => void) | null;
}) {
  const { supervisor } = room;
  const folded = room.desks.filter((desk) => isFolded(desk, now));
  const desks = showDone ? room.desks : room.desks.filter((desk) => !isFolded(desk, now));
  const meta = roomMeta(supervisor);
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: compact ? 8 : 12, gap: 10, backgroundColor: theme.colors.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8 }}>
          <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: FONT.title, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
            {supervisor.workspaceName}
          </Text>
          {meta ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, flexShrink: 1 }} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        {onCollapse ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Fold ${supervisor.title}'s room`} onPress={onCollapse} hitSlop={8} style={{ paddingHorizontal: 6, minHeight: 28, justifyContent: "center" }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }}>Fold ▴</Text>
          </Pressable>
        ) : null}
      </View>
      <SupervisorDesk theme={theme} room={room} now={now} motion={motion} onOpen={openChat ? () => openChat(supervisor.serverId, supervisor.id) : null} />
      {/* The team hangs off the supervisor's desk like an org chart: a spine on the left. */}
      <View style={{ marginLeft: compact ? 14 : 30, paddingLeft: compact ? 10 : 14, borderLeftWidth: 2, borderLeftColor: theme.colors.border, gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }}>
          {room.desks.length === 0 ? "No handoffs yet. This supervisor is working alone." : `Team · ${roomSummary(room)}`}
        </Text>
        {desks.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {desks.map((desk) => (
              <View key={desk.key} style={compact ? { width: "100%" } : { width: 208 }}>
                <DeskCard
                  theme={theme}
                  compact={compact}
                  desk={desk}
                  now={now}
                  fresh={seen !== null && !seen.has(desk.key)}
                  motion={motion}
                  onOpen={openChat && desk.open ? () => openChat(desk.open!.serverId, desk.open!.agentId) : null}
                  onAnswer={desk.state === "waiting" ? onAnswer : null}
                />
              </View>
            ))}
          </View>
        ) : null}
        {folded.length > 0 && !showDone ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }}>
            ✓ {folded.length} finished {folded.length === 1 ? "engineer" : "engineers"} left
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** A quiet room folded into one line. Tap to unfold. */
function QuietRow({ theme, room, now, onPress }: { theme: PluginTheme; room: Room; now: number; onPress: () => void }) {
  const { supervisor } = room;
  const { icon, label } = DESK_STATE[room.supervisorState];
  const done = room.desks.filter((desk) => isFinished(desk)).length;
  const detail = [label, formatElapsed(now - supervisor.since), done ? `${done} done` : null].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${supervisor.title}, ${supervisor.workspaceName}, ${detail}`}
      accessibilityHint="Unfolds the room"
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: pressed ? tint(theme.colors.foreground, 0.07) : hovered ? tint(theme.colors.foreground, 0.04) : "transparent",
      })}
    >
      <Text style={{ width: 16, textAlign: "center", color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: FONT.meta }}>{icon}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: FONT.body, fontWeight: "500" }} numberOfLines={1}>
          {supervisor.title}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }} numberOfLines={1}>
          {supervisor.workspaceName} · {detail}
        </Text>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }}>▾</Text>
    </Pressable>
  );
}

/** Office head count: icon, number and word for each state, so it reads without colour. */
function HeadCount({ theme, rooms, compact }: { theme: PluginTheme; rooms: readonly Room[]; compact: boolean }) {
  const counts = officeCounts(rooms);
  const items: { state: DeskState; count: number; word: string }[] = [
    { state: "waiting", count: counts.waiting, word: compact ? "waiting" : "waiting on you" },
    { state: "stuck", count: counts.stuck, word: "stuck" },
    { state: "working", count: counts.working, word: "working" },
    { state: "done", count: counts.done, word: "done" },
  ];
  const shown = items.filter((item) => item.count > 0);
  if (shown.length === 0) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.body }}>– Nobody at work right now</Text>;
  }
  return (
    <View accessibilityRole="summary" style={{ flexDirection: "row", flexWrap: "wrap", gap: compact ? 6 : 8 }}>
      {shown.map(({ state, count, word }) => {
        const zero = count === 0;
        return (
          <View
            key={state}
            accessible
            accessibilityLabel={`${count} ${state === "waiting" ? "waiting on you" : word}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: compact ? 8 : 10,
              paddingVertical: 4,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: !zero && (state === "waiting" || state === "stuck") ? stateColor(theme, state) : theme.colors.border,
            }}
          >
            <Text style={{ color: zero ? theme.colors.foregroundMuted : stateColor(theme, state), fontFamily: MONO, fontSize: FONT.meta, fontWeight: "700" }}>{DESK_STATE[state].icon}</Text>
            <Text style={{ color: zero ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: FONT.row, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{count}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.body }}>{word}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function OfficeScreen({ theme, layout, navigation, host, onOpenLive }: PluginScreenProps & { onOpenLive?: () => void }) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
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
  const anyFolded = rooms.some((room) => room.desks.some((desk) => isFolded(desk, now)));
  const openChat = navigation ? (serverId: string, agentId: string) => navigation.openAgent({ agentId, serverId }) : null;
  const toggle = (key: string) => {
    const next = new Set(unfolded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setUnfolded(next);
  };
  const busy = rooms.filter((room) => !isQuiet(room, now) || unfolded.has(room.key));
  const quiet = rooms.filter((room) => isQuiet(room, now) && !unfolded.has(room.key));

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pagePadding(compact), gap: 14, width: "100%", maxWidth: 1080, alignSelf: "center" }}>
      <View style={{ gap: 8 }}>
        <HeadCount theme={theme} rooms={rooms} compact={compact} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, lineHeight: 17 }}>
          Supervisors hand work to the engineers at their desks. Tap anyone to open their chat.
        </Text>
      </View>
      {rooms.length === 0 ? (
        <View style={{ alignItems: "center", gap: 10, paddingVertical: 28 }}>
          <Scene theme={theme} state="closed" motion={false} small={false} />
          <EmptyNote theme={theme}>The office is empty. Start an agent in Paseo and it gets a room here.</EmptyNote>
        </View>
      ) : null}
      {busy.length === 0 && quiet.length > 0 ? (
        <EmptyNote theme={theme}>✓ Nobody is working or waiting on you right now.</EmptyNote>
      ) : null}
      {busy.map((room) => (
        <RoomView
          key={room.key}
          theme={theme}
          compact={compact}
          room={room}
          now={now}
          seen={seen}
          motion={motion}
          openChat={openChat}
          showDone={showDone}
          onCollapse={unfolded.has(room.key) ? () => toggle(room.key) : null}
          onAnswer={onOpenLive ?? null}
        />
      ))}
      {quiet.length > 0 ? (
        <View style={{ gap: 2 }}>
          <Text accessibilityRole="header" style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, fontWeight: "600", letterSpacing: 0.4, paddingHorizontal: 2, paddingBottom: 4 }}>
            QUIET ROOMS · {quiet.length}
          </Text>
          <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 2 }}>
            {quiet.map((room) => (
              <QuietRow key={room.key} theme={theme} room={room} now={now} onPress={() => toggle(room.key)} />
            ))}
          </View>
        </View>
      ) : null}
      {anyFolded || closedCount > 0 ? (
        <View style={{ gap: 6 }}>
          {anyFolded ? (
            <Toggle theme={theme} open={showDone} onPress={() => setShowDone(!showDone)} label={showDone ? "Hide finished engineers" : "Show finished engineers"} />
          ) : null}
          {closedCount > 0 ? (
            <Toggle theme={theme} open={showClosed} onPress={() => setShowClosed(!showClosed)} label={showClosed ? "Hide closed agents" : `Show closed agents · ${closedCount}`} />
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}
