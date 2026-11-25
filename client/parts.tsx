/**
 * Small shared pieces for Mission Control surfaces: status pills, buttons and formatting. Colours
 * come only from the Paseo theme, and every status carries a text label (never colour alone).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { STATUS_LABEL, type AgentStatus } from "../shared/live";

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

export function Pill({ theme, label, color }: { theme: PluginTheme; label: string; color: string }) {
  const styles = useMemo(
    () => ({
      pill: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color,
        alignSelf: "flex-start" as const,
      },
      dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color },
      text: { color: theme.colors.foreground, fontSize: 12 },
    }),
    [theme, color],
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
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: primary ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
        flexDirection: "row" as const,
        gap: 6,
        alignItems: "center" as const,
      },
      text: {
        color: primary ? theme.colors.accentForeground : danger ? theme.colors.statusDanger : theme.colors.foreground,
        fontSize: 13,
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
