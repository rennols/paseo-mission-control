/**
 * The 30-minute activity lane on each agent row. Working is a solid bar, idle a thin line, waiting
 * on you a dashed amber bar, stuck a red bar. A tick marks each repeat of the same error, a green
 * cap marks when the agent finished, and the right edge is now. The server sends segments with
 * each snapshot (every 15 s while open), so the lane keeps moving without client timers.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { View, type DimensionValue } from "react-native";
import type { LaneMark, LaneSegment } from "../shared/live";

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
      lane: { height: HEIGHT, flex: 1, minWidth: 80, position: "relative" as const, justifyContent: "center" as const },
      track: { position: "absolute" as const, left: 0, right: 0, height: 1, top: HEIGHT / 2, backgroundColor: theme.colors.border },
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
    </View>
  );
}
