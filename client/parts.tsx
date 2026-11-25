/**
 * Small shared pieces for Mission Control surfaces: type and spacing scale, status pills, buttons,
 * section headers and the loading, error and empty states. Colours come only from the Paseo theme,
 * and every status carries a text label (never colour alone).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Loading } from "@getpaseo/plugin/client/ui";
import { useMemo, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { STATUS_LABEL, type AgentStatus } from "../shared/live";
import { tint } from "./ui-format";

export { tint };

/** Type scale shared by every surface: section titles, row titles, body text and meta lines. */
export const FONT = { title: 15, row: 14, body: 13, meta: 12 } as const;

/** Page padding: 12 on a phone (360 px), 20 on a desk. */
export function pagePadding(compact: boolean): number {
  return compact ? 12 : 20;
}

/** Code, paths and commands. Web gets a real monospace stack; "monospace" alone falls back oddly. */
export const MONO = Platform.select({
  web: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  default: "monospace",
});

/** The panel style every card uses: Mission Control's cards, the Needs you list, the report. */
export function cardStyle(theme: PluginTheme) {
  return {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    padding: 12,
    gap: 8,
    backgroundColor: theme.colors.surface1,
  };
}

export function statusColor(theme: PluginTheme, status: AgentStatus): string {
  switch (status) {
    case "working":
      return theme.colors.accent;
    case "waiting":
      return theme.colors.statusWarning;
    case "stuck":
    case "error":
      return theme.colors.statusDanger;
    case "idle":
      return theme.colors.statusSuccess;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * A status pill in Paseo's badge style: a tinted fill, a coloured dot and the label in the normal
 * text colour, so it reads in light and dark themes. `square` is the 4 px corner Paseo uses for
 * sidebar badges, `dashed` an empty outline (a free slot), and `shrink` lets a long label truncate.
 */
export function Pill({
  theme,
  label,
  color,
  square = false,
  dashed = false,
  shrink = false,
}: {
  theme: PluginTheme;
  label: string;
  color: string;
  square?: boolean;
  dashed?: boolean;
  shrink?: boolean;
}) {
  const styles = useMemo(
    () => ({
      pill: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: square ? 4 : 999,
        borderWidth: dashed ? 1 : 0,
        borderStyle: dashed ? ("dashed" as const) : undefined,
        borderColor: dashed ? theme.colors.border : undefined,
        backgroundColor: dashed ? "transparent" : tint(color, 0.14),
        alignSelf: "flex-start" as const,
        flexShrink: shrink ? 1 : 0,
        minWidth: 0,
      },
      dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: dashed ? theme.colors.foregroundMuted : color },
      text: { color: dashed ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: FONT.meta, lineHeight: 18, flexShrink: 1 },
    }),
    [theme, color, square, dashed, shrink],
  );
  return (
    <View style={styles.pill} accessible accessibilityLabel={label}>
      <View style={styles.dot} />
      <Text style={styles.text} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function StatusPill({ theme, status }: { theme: PluginTheme; status: AgentStatus }) {
  return <Pill theme={theme} label={STATUS_LABEL[status]} color={statusColor(theme, status)} />;
}

export function Button({
  theme,
  label,
  onPress,
  primary = false,
  danger = false,
  busy = false,
  disabled = false,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const styles = useMemo(
    () => ({
      button: {
        minHeight: 32,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: primary ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
        flexDirection: "row" as const,
        gap: 6,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      text: {
        color: primary ? theme.colors.accentForeground : danger ? theme.colors.statusDanger : theme.colors.foreground,
        fontSize: FONT.body,
        fontWeight: "500" as const,
      },
    }),
    [theme, primary, danger, disabled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={styles.button}
    >
      {busy ? <ActivityIndicator size="small" color={styles.text.color} /> : null}
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}

/** A section title with its count in muted text: "Needs you 2". */
export function SectionHeader({
  theme,
  title,
  count,
  size = "title",
  trailing,
}: {
  theme: PluginTheme;
  title: string;
  count?: number;
  size?: "title" | "small";
  trailing?: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
      <Text
        accessibilityRole="header"
        accessibilityLabel={count === undefined ? title : `${title}, ${count}`}
        style={{ color: theme.colors.foreground, fontSize: size === "title" ? FONT.title : FONT.body, fontWeight: "600", flexShrink: 1 }}
        numberOfLines={1}
      >
        {title}
        {count === undefined ? null : <Text style={{ color: theme.colors.foregroundMuted, fontWeight: "400" }}>{`  ${count}`}</Text>}
      </Text>
      {trailing ? <View style={{ marginLeft: "auto" }}>{trailing}</View> : null}
    </View>
  );
}

/** One muted line for an empty list, with the same spacing everywhere. */
export function EmptyNote({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.body, paddingVertical: 6, lineHeight: 19 }}>{children}</Text>;
}

/**
 * What a tab shows before its first snapshot: Paseo's own loading state, or why it could not
 * connect. A subscription starts again when the screen mounts, so reopening it retries.
 */
export function ScreenState({ theme, hostLabel, error }: { theme: PluginTheme; hostLabel: string; error: string | null }) {
  if (error === null) return <Loading />;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 6 }} accessibilityRole="alert">
      <Text style={{ color: theme.colors.foreground, fontSize: FONT.body, fontWeight: "600", textAlign: "center" }}>
        ⚠ Mission Control could not connect to {hostLabel}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, textAlign: "center", maxWidth: 420 }}>{error}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta, textAlign: "center" }}>Close Mission Control and open it again to retry.</Text>
    </View>
  );
}
