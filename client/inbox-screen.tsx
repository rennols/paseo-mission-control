/**
 * Mission Control, Review inbox tab: agents on this host that finished with changes still in their
 * worktree, oldest first. Renders what the server pushes on `inbox.watch`. Commit and open PR and
 * Send back are one RPC each, from a click; nothing runs on its own.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ExternalLink, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { commitAndOpenPr, inboxWatch, sendBack, type InboxItem, type InboxSnapshot } from "../shared/queue";
import { Button, Pill, formatElapsed } from "./parts";

const FILES_SHOWN = 12;

function InboxCard({
  theme,
  item,
  now,
  onOpenChat,
}: {
  theme: PluginTheme;
  item: InboxItem;
  now: number;
  onOpenChat: ((agentId: string) => void) | null;
}) {
  const toast = useToast();
  const openPr = useRpc(commitAndOpenPr);
  const back = useRpc(sendBack);
  const [busy, setBusy] = useState<"pr" | "back" | null>(null);
  const [title, setTitle] = useState(item.title);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [allFiles, setAllFiles] = useState(false);

  const styles = useMemo(
    () => ({
      card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12, gap: 8, backgroundColor: theme.colors.surface1 },
      title: { color: theme.colors.foreground, fontWeight: "600" as const, fontSize: 14, flexShrink: 1 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      body: { color: theme.colors.foreground, fontSize: 13 },
      mono: { color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 8,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
      },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
    }),
    [theme],
  );

  if (item.state !== "open") {
    return (
      <View style={{ flexDirection: "row", gap: 6, paddingVertical: 6, paddingHorizontal: 4, flexWrap: "wrap" }} accessible accessibilityLabel={`${item.title}: ${item.resolution ?? ""}`}>
        <Text style={styles.muted}>✓ {item.title}:</Text>
        {item.prUrl ? (
          <ExternalLink href={item.prUrl} accessibilityLabel={`Open the PR for ${item.title}`}>
            PR opened
          </ExternalLink>
        ) : (
          <Text style={styles.muted} numberOfLines={2}>
            {item.resolution ?? "Done."}
          </Text>
        )}
      </View>
    );
  }

  const files = allFiles ? item.files : item.files.slice(0, FILES_SHOWN);
  const where = [item.provider, item.workspaceName, item.branch ? `${item.branch}${item.baseBranch ? ` → ${item.baseBranch}` : ""}` : null].filter(Boolean).join(" · ");
  const state = [
    item.uncommitted ? "uncommitted changes" : null,
    item.commitsAhead > 0 ? `${item.commitsAhead} commit${item.commitsAhead === 1 ? "" : "s"} ahead` : null,
  ]
    .filter(Boolean)
    .join(", ");

  async function doPr(): Promise<void> {
    setBusy("pr");
    try {
      const result = await openPr({ itemId: item.id, title: title.trim() || item.title });
      if (result.ok) toast.show(result.prUrl ? `PR opened: ${result.prUrl}` : result.message);
      else toast.error(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function doSendBack(): Promise<void> {
    setBusy("back");
    try {
      const result = await back({ itemId: item.id, note: note.trim() });
      if (result.ok) toast.show(result.message);
      else toast.error(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        <Pill theme={theme} label="Ready for review" color={theme.colors.statusSuccess} />
        <Text style={[styles.muted, { marginLeft: "auto" }]}>finished {formatElapsed(now - item.finishedAt)} ago</Text>
      </View>
      <Text style={styles.muted} numberOfLines={2}>
        {where}
      </Text>
      {item.failedChecks.length > 0 ? (
        <View style={{ gap: 2 }}>
          {item.failedChecks.map((check) => (
            <Text key={check} style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
              ✗ Failed check: {check}
            </Text>
          ))}
        </View>
      ) : null}
      {item.summary ? (
        <Text style={styles.body} numberOfLines={8}>
          {item.summary}
        </Text>
      ) : null}
      <Text style={styles.muted}>
        {item.files.length} file{item.files.length === 1 ? "" : "s"} · +{item.linesAdded} −{item.linesRemoved}
        {state ? ` · ${state}` : ""}
      </Text>
      <View style={{ gap: 2 }}>
        {files.map((file) => (
          <View key={file.path} style={{ flexDirection: "row", gap: 8 }}>
            <Text style={[styles.mono, { flexShrink: 1 }]} numberOfLines={1}>
              {file.path}
              {file.untracked ? " (new)" : ""}
            </Text>
            <Text style={[styles.muted, { marginLeft: "auto" }]}>{file.added === null ? "binary" : `+${file.added} −${file.removed ?? 0}`}</Text>
          </View>
        ))}
        {item.files.length > FILES_SHOWN ? (
          <Button theme={theme} label={allFiles ? "Fewer files" : `All ${item.files.length} files`} onPress={() => setAllFiles(!allFiles)} />
        ) : null}
      </View>
      {item.diffExcerpt ? (
        showDiff ? (
          <ScrollView horizontal style={{ maxHeight: 320, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface0 }}>
            <Text style={[styles.mono, { padding: 8 }]} selectable>
              {item.diffExcerpt}
              {item.diffTruncated ? "\n…" : ""}
            </Text>
          </ScrollView>
        ) : null
      ) : null}
      <Text style={styles.muted}>Commit message and PR title</Text>
      <TextInput accessibilityLabel="Commit message and PR title" value={title} onChangeText={setTitle} style={styles.input} />
      {noteOpen ? (
        <TextInput
          accessibilityLabel={`Note for ${item.title}`}
          multiline
          value={note}
          onChangeText={setNote}
          placeholder="What should it change? This becomes its next prompt."
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]}
        />
      ) : null}
      <View style={styles.row}>
        {noteOpen ? (
          <>
            <Button theme={theme} primary label="Send back" busy={busy === "back"} disabled={!note.trim() || busy !== null} onPress={() => void doSendBack()} accessibilityLabel={`Send ${item.title} back with the note`} />
            <Button theme={theme} label="Cancel" onPress={() => setNoteOpen(false)} />
          </>
        ) : (
          <>
            <Button theme={theme} primary label="Commit and open PR" busy={busy === "pr"} disabled={busy !== null} onPress={() => void doPr()} accessibilityLabel={`Commit and open a PR for ${item.title}`} />
            <Button theme={theme} label="Send back" disabled={busy !== null} onPress={() => setNoteOpen(true)} accessibilityLabel={`Send ${item.title} back with a note`} />
          </>
        )}
        {item.diffExcerpt ? <Button theme={theme} label={showDiff ? "Hide diff" : "Show diff"} onPress={() => setShowDiff(!showDiff)} /> : null}
        {onOpenChat ? <Button theme={theme} label="Open chat" onPress={() => onOpenChat(item.agentId)} accessibilityLabel={`Open chat with ${item.title}`} /> : null}
      </View>
    </View>
  );
}

export function InboxScreen({ theme, layout, navigation, host }: PluginScreenProps) {
  const [snapshot, setSnapshot] = useState<InboxSnapshot | null>(null);
  const subscription = useSubscription(inboxWatch, {}, setSnapshot);
  const note = { color: theme.colors.foregroundMuted, fontSize: 12 };

  if (!snapshot) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 }}>
        {subscription.status === "error" ? (
          <>
            <Text style={{ color: theme.colors.statusDanger }}>Mission Control could not connect to {host.label}.</Text>
            <Text style={note}>{subscription.error.message}</Text>
          </>
        ) : (
          <ActivityIndicator color={theme.colors.foregroundMuted} />
        )}
      </View>
    );
  }

  const open = snapshot.items.filter((item) => item.state === "open");
  const resolved = snapshot.items.filter((item) => item.state !== "open");
  const openChat = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : null;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }} accessibilityRole="header">
        Ready for review · {open.length}
      </Text>
      {open.length === 0 ? <Text style={note}>Nothing to review on {snapshot.hostLabel}. Agents that finish with changes in their worktree show up here.</Text> : null}
      {open.map((item) => (
        <InboxCard key={item.id} theme={theme} item={item} now={snapshot.generatedAt} onOpenChat={openChat} />
      ))}
      {resolved.length > 0 ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }} accessibilityRole="header">
            Done in the last 24 hours
          </Text>
          {resolved.map((item) => (
            <InboxCard key={item.id} theme={theme} item={item} now={snapshot.generatedAt} onOpenChat={openChat} />
          ))}
        </View>
      ) : null}
      <Text style={note}>
        Commit and open PR runs git add, commit and push, then gh pr create, in that agent's worktree. The inbox is per host.
      </Text>
    </ScrollView>
  );
}
