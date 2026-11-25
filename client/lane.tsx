/**
 * The 30-minute activity lane on each agent row. Working is a solid bar, idle a thin line, waiting
 * on you a dashed amber bar, stuck a red bar. A tick marks each repeat of the same error, a green
 * cap marks when the agent finished, and the right edge is now (a short muted bar). Faint lines
 * split the track into 5-minute steps, as in the mockup. The server sends segments with
 * each snapshot (every 15 s while open), so the lane keeps moving without client timers.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View, type DimensionValue } from "react-native";
import type { LaneMark, LaneSegment } from "../shared/live";
import { FONT, tint } from "./parts";

const WINDOW_MS = 30 * 60_000;
const HEIGHT = 14;

function pct(value: number): DimensionValue {
  return `${Math.max(0, Math.min(100, value * 100)).toFixed(2)}%` as DimensionValue;
}

export function Lane({
  theme,
  segments,
  marks,
  now,
  description,
}: {
  theme: PluginTheme;
  segments: readonly LaneSegment[];
  marks: readonly LaneMark[];
  now: number;
  description: string;
}) {
  const start = now - WINDOW_MS;
  const styles = useMemo(
    () => ({
      lane: {
        height: HEIGHT,
        flex: 1,
        minWidth: 80,
        position: "relative" as const,
        justifyContent: "center" as const,
        borderRadius: 4,
        backgroundColor: tint(theme.colors.foreground, 0.035),
      },
      track: { position: "absolute" as const, left: 0, right: 0, height: 1, top: HEIGHT / 2, backgroundColor: theme.colors.border },
      step: { position: "absolute" as const, top: 0, bottom: 0, width: 1, backgroundColor: theme.colors.border, opacity: 0.6 },
      now: { position: "absolute" as const, right: 0, top: -2, bottom: -2, width: 2, borderRadius: 1, backgroundColor: theme.colors.foregroundMuted },
    }),
    [theme],
  );

  function segmentStyle(segment: LaneSegment) {
    const left = pct((segment.from - start) / WINDOW_MS);
    const width = pct((segment.to - segment.from) / WINDOW_MS);
    const base = { position: "absolute" as const, left, width, borderRadius: 2 };
    switch (segment.kind) {
      case "working":
        return { ...base, top: 3, height: 8, backgroundColor: theme.colors.accent };
      case "waiting":
        return {
          ...base,
          top: 3,
          height: 8,
          borderWidth: 2,
          borderStyle: "dashed" as const,
          borderColor: theme.colors.statusWarning,
        };
      case "stuck":
        return { ...base, top: 3, height: 8, backgroundColor: theme.colors.statusDanger };
      default:
        return { ...base, top: HEIGHT / 2 - 1, height: 2, backgroundColor: theme.colors.foregroundMuted };
    }
  }

  return (
    <View style={styles.lane} accessible accessibilityRole="image" accessibilityLabel={description}>
      {[1, 2, 3, 4, 5].map((step) => (
        <View key={step} style={[styles.step, { left: pct(step / 6) }]} />
      ))}
      <View style={styles.track} />
      {segments.map((segment) => (
        <View key={`${segment.kind}-${segment.from}`} style={segmentStyle(segment)} />
      ))}
      {marks.map((mark) => (
        <View
          key={`${mark.kind}-${mark.at}`}
          style={{
            position: "absolute",
            left: pct((mark.at - start) / WINDOW_MS),
            top: 0,
            width: mark.kind === "finished" ? 3 : 2,
            height: HEIGHT,
            marginLeft: -1,
            borderRadius: 1,
            backgroundColor: mark.kind === "finished" ? theme.colors.statusSuccess : theme.colors.foreground,
          }}
        />
      ))}
      <View style={styles.now} />
    </View>
  );
}

/** The key under the agent tree: each lane mark with its words, so no mark is colour alone. */
export function LaneLegend({ theme }: { theme: PluginTheme }) {
  const swatch = { width: 18, height: 8, borderRadius: 2 };
  const items: { label: string; style: object }[] = [
    { label: "Working", style: { ...swatch, backgroundColor: theme.colors.accent } },
    { label: "Idle", style: { ...swatch, height: 2, backgroundColor: theme.colors.foregroundMuted } },
    { label: "Waiting on you", style: { ...swatch, borderWidth: 2, borderStyle: "dashed", borderColor: theme.colors.statusWarning } },
    { label: "Stuck", style: { ...swatch, backgroundColor: theme.colors.statusDanger } },
    { label: "Same error again", style: { width: 2, height: 12, borderRadius: 1, backgroundColor: theme.colors.foreground } },
    { label: "Finished", style: { width: 3, height: 12, borderRadius: 1, backgroundColor: theme.colors.statusSuccess } },
  ];
  return (
    <View
      accessible
      accessibilityLabel="Activity lanes cover the last 30 minutes, now on the right."
      style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 6, paddingHorizontal: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }}>Last 30 min:</Text>
      {items.map((item) => (
        <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={item.style} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}
