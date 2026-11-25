/**
 * The overnight report card at the top of the Queue tab (PRD: Overnight report, P2): what ran from
 * the queue in the overnight window, what each run changed and what it needs from you. Renders what
 * the server pushes on `report.overnight.watch`; it runs nothing itself.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useSubscription } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { TASK_STATE_LABEL, type TaskState } from "../shared/queue";
import { overnightReportWatch, type OvernightReport, type ReportNeed, type ReportRun } from "../shared/report";
import { Button, FONT, MONO, Pill, cardStyle } from "./parts";

function stateColor(theme: PluginTheme, state: TaskState): string {
  if (state === "finished") return theme.colors.statusSuccess;
  if (state === "failed") return theme.colors.statusDanger;
  if (state === "stopped") return theme.colors.statusWarning;
  if (state === "queued") return theme.colors.foregroundMuted;
  return theme.colors.accent;
}

function needColor(theme: PluginTheme, need: ReportNeed): string {
  if (need.kind === "review") return theme.colors.statusSuccess;
  if (need.kind === "stuck" || need.kind === "retry") return theme.colors.statusDanger;
  return theme.colors.statusWarning;
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "3 finished, 1 failed, 1 stopped" without the zero parts. */
export function tally(report: OvernightReport): string {
  const { counts } = report;
  const parts = [
    counts.finished ? `${counts.finished} finished` : null,
    counts.failed ? `${counts.failed} failed` : null,
    counts.stopped ? `${counts.stopped} stopped` : null,
    counts.running ? `${counts.running} still running` : null,
  ].filter(Boolean);
  return `${plural(counts.runs, "run")}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

function RunRow({
  theme,
  run,
  onOpenChat,
  onOpenInbox,
}: {
  theme: PluginTheme;
  run: ReportRun;
  onOpenChat: ((agentId: string) => void) | null;
  onOpenInbox: (() => void) | null;
}) {
  const muted = { color: theme.colors.foregroundMuted, fontSize: FONT.meta };
  const body = { color: theme.colors.foreground, fontSize: FONT.meta, lineHeight: 17 };
  const when = `${clock(run.startedAt)} to ${run.finishedAt ? clock(run.finishedAt) : "now"}`;
  const changes = run.changes
    ? run.changes.files === 0
      ? "No file changes"
      : `${plural(run.changes.files, "file")} · +${run.changes.linesAdded} −${run.changes.linesRemoved}${run.changes.sample.length ? ` · ${run.changes.sample.join(", ")}${run.changes.files > run.changes.sample.length ? ", …" : ""}` : ""}`
    : null;
  return (
    <View style={{ paddingVertical: 12, gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <Text style={{ color: theme.colors.foreground, fontSize: FONT.row, fontWeight: "500" }} numberOfLines={2}>
        {run.title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Pill theme={theme} label={TASK_STATE_LABEL[run.state]} color={stateColor(theme, run.state)} />
        <Text style={[muted, { flexShrink: 1 }]} numberOfLines={1}>
          {[run.projectName, when, run.startedBy === "user" ? "started by you" : null].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {run.outcome ? (
        <Text style={body} numberOfLines={3}>
          {run.outcome}
        </Text>
      ) : null}
      {changes ? (
        <Text style={body} numberOfLines={2} accessibilityLabel={`Changed: ${changes}`}>
          {changes}
        </Text>
      ) : null}
      {run.checks.map((check) => (
        <Text
          key={check.command}
          style={{ color: check.passed ? theme.colors.foreground : theme.colors.statusDanger, fontSize: FONT.meta, fontFamily: MONO }}
          numberOfLines={2}
          accessibilityLabel={`${check.command} ${check.passed ? "passed" : "failed"}${check.line ? `: ${check.line}` : ""}`}
        >
          {check.passed ? "✓" : "✗"} {check.command}
          {check.line ? `: ${check.line}` : ""}
        </Text>
      ))}
      {run.needs.map((need) => (
        <View key={`${need.kind}:${need.label}`} style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
          <View style={{ width: 3, alignSelf: "stretch", borderRadius: 2, backgroundColor: needColor(theme, need) }} />
          <Text style={{ color: theme.colors.foreground, fontSize: FONT.meta, fontWeight: "600", flexShrink: 1 }} numberOfLines={3}>
            Needs you: {need.label}
          </Text>
        </View>
      ))}
      {run.review?.state === "pr_opened" ? (
        run.review.prUrl ? (
          <ExternalLink href={run.review.prUrl} accessibilityLabel={`Open the PR for ${run.title}`}>
            PR opened
          </ExternalLink>
        ) : (
          <Text style={muted}>PR opened</Text>
        )
      ) : run.review?.state === "sent_back" ? (
        <Text style={muted}>Sent back to the agent</Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {run.review?.state === "open" && onOpenInbox ? (
          <Button theme={theme} primary label="Review" onPress={onOpenInbox} accessibilityLabel={`Review ${run.title} in the Review inbox`} />
        ) : null}
        {run.agentId && onOpenChat ? (
          <Button theme={theme} label="Open chat" onPress={() => onOpenChat(run.agentId as string)} accessibilityLabel={`Open chat for ${run.title}`} />
        ) : null}
      </View>
    </View>
  );
}

export function OvernightReportCard({
  theme,
  onOpenChat,
  onOpenInbox,
}: {
  theme: PluginTheme;
  onOpenChat: ((agentId: string) => void) | null;
  onOpenInbox: (() => void) | null;
}) {
  const [report, setReport] = useState<OvernightReport | null>(null);
  const [open, setOpen] = useState(true);
  useSubscription(overnightReportWatch, {}, setReport);
  const styles = useMemo(
    () => ({
      card: { ...cardStyle(theme), gap: 6 },
      title: { color: theme.colors.foreground, fontSize: FONT.title, fontWeight: "600" as const },
      note: { color: theme.colors.foregroundMuted, fontSize: FONT.meta, lineHeight: 17 },
    }),
    [theme],
  );
  if (!report) return null;

  const { counts, window } = report;
  const heading = window.inProgress ? "Overnight report: tonight so far" : "Overnight report: last night";
  const range = `${window.start} to ${window.end}`;

  if (counts.runs === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.title} accessibilityRole="header">
          {heading}
        </Text>
        <Text style={styles.note}>
          No queue runs {window.inProgress ? "so far tonight" : "last night"} ({range} on {report.hostLabel}).
          {counts.stillQueued ? ` ${plural(counts.stillQueued, "task")} queued.` : ""}
        </Text>
      </View>
    );
  }

  const summary = [
    tally(report),
    counts.review ? `${counts.review} in the Review inbox` : null,
    counts.needsYou ? `${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you` : "nothing needs you",
    counts.stillQueued ? `${counts.stillQueued} still queued` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${heading}. ${summary}. ${open ? "Hide" : "Show"} runs`}
        onPress={() => setOpen(!open)}
        style={{ gap: 4 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={[styles.title, { flexShrink: 1 }]} accessibilityRole="header">
            {heading}
          </Text>
          <Text style={[styles.note, { marginLeft: "auto", color: theme.colors.foreground }]}>{open ? "Hide runs ▴" : "Show runs ▾"}</Text>
        </View>
        <Text style={styles.note}>
          {range} on {report.hostLabel}
        </Text>
        <Text style={{ color: theme.colors.foreground, fontSize: FONT.body, lineHeight: 19 }}>{summary}</Text>
      </Pressable>
      {open ? report.runs.map((run) => <RunRow key={run.taskId} theme={theme} run={run} onOpenChat={onOpenChat} onOpenInbox={onOpenInbox} />) : null}
    </View>
  );
}
