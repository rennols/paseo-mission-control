/**
 * Mission Control, Queue tab: slot capacity on this host, the Add task form and the task list.
 * Renders what the server pushes on `queue.watch`; every action is one RPC from a click.
 * The queue is per host: it shows and starts tasks on the host this screen is open on.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { STATUS_LABEL } from "../shared/live";
import {
  TASK_STATE_LABEL,
  addTask,
  moveTaskUp,
  queueWatch,
  removeTask,
  retryTask,
  startTaskNow,
  type Choice,
  type QueueSnapshot,
  type QueueTask,
  type TaskState,
} from "../shared/queue";
import { Button, Pill, formatElapsed, statusColor } from "./parts";

function stateColor(theme: PluginTheme, state: TaskState): string {
  switch (state) {
    case "queued":
      return theme.colors.foregroundMuted;
    case "starting":
    case "running":
      return theme.colors.accent;
    case "finished":
      return theme.colors.statusSuccess;
    case "failed":
      return theme.colors.statusDanger;
    case "stopped":
      return theme.colors.statusWarning;
  }
}

type ActionResult = { ok: boolean; message: string };

function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function run(key: string, action: () => Promise<ActionResult>): Promise<boolean> {
    setBusy(key);
    try {
      const result = await action();
      if (result.ok) toast.show(result.message);
      else toast.error(result.message);
      return result.ok;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { busy, run };
}

function ChoiceChips({
  theme,
  label,
  choices,
  value,
  onChange,
}: {
  theme: PluginTheme;
  label: string;
  choices: Choice[];
  value: string | null;
  onChange: (key: string) => void;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500" }}>{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {choices.map((choice) => {
          const active = choice.key === value;
          return (
            <Pressable
              key={choice.key}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={choice.detail ? `${choice.label}, ${choice.detail}` : choice.label}
              onPress={() => onChange(choice.key)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: active ? theme.colors.accent : theme.colors.border,
                backgroundColor: active ? theme.colors.surface2 : "transparent",
                maxWidth: "100%",
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
                {active ? "✓ " : ""}
                {choice.label}
              </Text>
              {choice.detail ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                  {choice.detail}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function AddTaskForm({ theme, snapshot, onDone }: { theme: PluginTheme; snapshot: QueueSnapshot; onDone: () => void }) {
  const add = useRpc(addTask);
  const { busy, run } = useAction();
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [project, setProject] = useState<string | null>(snapshot.projects.length === 1 ? (snapshot.projects[0]?.key ?? null) : null);
  const [profile, setProfile] = useState<string | null>(snapshot.profiles[0]?.key ?? null);

  useEffect(() => {
    if (project === null && snapshot.projects.length === 1) setProject(snapshot.projects[0]?.key ?? null);
    if (profile === null && snapshot.profiles.length > 0) setProfile(snapshot.profiles[0]?.key ?? null);
  }, [snapshot.projects, snapshot.profiles, project, profile]);

  const input = {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 8,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
  };
  const label = { color: theme.colors.foreground, fontSize: 13, fontWeight: "500" as const };
  const note = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const ready = prompt.trim().length > 0 && project !== null && profile !== null;

  return (
    <View style={{ gap: 10, padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface1 }}>
      <Text style={label}>Prompt</Text>
      <TextInput
        accessibilityLabel="Task prompt"
        multiline
        value={prompt}
        onChangeText={setPrompt}
        placeholder="What should the agent do?"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={[input, { minHeight: 90, textAlignVertical: "top" }]}
      />
      <Text style={label}>Title (optional)</Text>
      <TextInput
        accessibilityLabel="Task title"
        value={title}
        onChangeText={setTitle}
        placeholder="From the prompt's first line"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={input}
      />
      {snapshot.projects.length === 0 ? (
        <Text style={note}>No git projects on {snapshot.hostLabel} yet. Open a project in Paseo first.</Text>
      ) : (
        <ChoiceChips theme={theme} label="Project" choices={snapshot.projects} value={project} onChange={setProject} />
      )}
      <ChoiceChips theme={theme} label="Agent profile" choices={snapshot.profiles} value={profile} onChange={setProfile} />
      <Text style={label}>Branch off (optional)</Text>
      <TextInput
        accessibilityLabel="Base branch"
        value={baseRef}
        onChangeText={setBaseRef}
        placeholder="The project's current branch"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={input}
      />
      <Text style={note}>Starts in a new worktree when a slot is free. It is a new branch; nothing is pushed until you open a PR from the Review inbox.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          theme={theme}
          primary
          label="Add to queue"
          busy={busy === "add"}
          disabled={!ready}
          onPress={() =>
            void run("add", () =>
              add({
                prompt: prompt.trim(),
                ...(title.trim() ? { title: title.trim() } : {}),
                projectKey: project as string,
                profileKey: profile as string,
                ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
              }),
            ).then((ok) => {
              if (ok) {
                setPrompt("");
                setTitle("");
                setBaseRef("");
                onDone();
              }
            })
          }
        />
        <Button theme={theme} label="Cancel" onPress={onDone} />
      </View>
    </View>
  );
}

function TaskRow({
  theme,
  task,
  firstQueued,
  now,
  onOpenChat,
}: {
  theme: PluginTheme;
  task: QueueTask;
  firstQueued: boolean;
  now: number;
  onOpenChat: ((agentId: string) => void) | null;
}) {
  const up = useRpc(moveTaskUp);
  const start = useRpc(startTaskNow);
  const remove = useRpc(removeTask);
  const retry = useRpc(retryTask);
  const { busy, run } = useAction();
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const when =
    task.state === "queued"
      ? `queued ${formatElapsed(now - task.createdAt)} ago`
      : task.finishedAt
        ? `${formatElapsed(now - task.finishedAt)} ago`
        : task.startedAt
          ? `for ${formatElapsed(now - task.startedAt)}`
          : null;
  return (
    <View style={{ paddingVertical: 10, paddingHorizontal: 8, gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "500", flexShrink: 1 }} numberOfLines={2}>
          {task.title}
        </Text>
        <Pill theme={theme} label={TASK_STATE_LABEL[task.state]} color={stateColor(theme, task.state)} />
        {task.overLimit ? <Pill theme={theme} label="Over slot limit" color={theme.colors.statusWarning} /> : null}
      </View>
      <Text style={muted} numberOfLines={1}>
        {[task.projectName, task.baseRef ? `off ${task.baseRef}` : null, task.profileLabel, when].filter(Boolean).join(" · ")}
      </Text>
      {task.outcome ? (
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={3}>
          {task.outcome}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {task.state === "queued" ? (
          <>
            <Button theme={theme} label="Start now" busy={busy === "start"} onPress={() => void run("start", () => start({ taskId: task.id }))} accessibilityLabel={`Start ${task.title} now`} />
            {!firstQueued ? (
              <Button theme={theme} label="Move up" busy={busy === "up"} onPress={() => void run("up", () => up({ taskId: task.id }))} accessibilityLabel={`Move ${task.title} up`} />
            ) : null}
            <Button theme={theme} danger label="Remove" busy={busy === "remove"} onPress={() => void run("remove", () => remove({ taskId: task.id }))} accessibilityLabel={`Remove ${task.title}`} />
          </>
        ) : null}
        {task.agentId && onOpenChat ? (
          <Button theme={theme} label="Open chat" onPress={() => onOpenChat(task.agentId as string)} accessibilityLabel={`Open chat for ${task.title}`} />
        ) : null}
        {task.state === "failed" || task.state === "stopped" ? (
          <Button theme={theme} label="Retry" busy={busy === "retry"} onPress={() => void run("retry", () => retry({ taskId: task.id }))} accessibilityLabel={`Retry ${task.title}`} />
        ) : null}
        {task.state === "finished" || task.state === "failed" || task.state === "stopped" ? (
          <Button theme={theme} label="Clear" busy={busy === "remove"} onPress={() => void run("remove", () => remove({ taskId: task.id }))} accessibilityLabel={`Clear ${task.title} from the list`} />
        ) : null}
      </View>
    </View>
  );
}

export function QueueScreen({ theme, layout, navigation, host }: PluginScreenProps) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [adding, setAdding] = useState(false);
  const subscription = useSubscription(queueWatch, {}, setSnapshot);
  const pad = layout.compact ? 12 : 20;
  const styles = useMemo(
    () => ({
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      note: { color: theme.colors.foregroundMuted, fontSize: 12 },
      card: { gap: 8, padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface1 },
    }),
    [theme],
  );

  if (!snapshot) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 }}>
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
  const busySlots = snapshot.holders.length;
  const free = Math.max(0, snapshot.slotLimit - busySlots);
  const firstQueuedId = snapshot.tasks.find((task) => task.state === "queued")?.id;
  const openChat = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : null;
  const queued = snapshot.tasks.filter((task) => task.state === "queued");
  const live = snapshot.tasks.filter((task) => task.state === "starting" || task.state === "running");
  const done = snapshot.tasks.filter((task) => task.state === "finished" || task.state === "failed" || task.state === "stopped");

  const section = (title: string, tasks: QueueTask[], empty: string) => (
    <View style={{ gap: 4 }}>
      <Text style={styles.title} accessibilityRole="header">
        {title} · {tasks.length}
      </Text>
      {tasks.length === 0 ? (
        <Text style={[styles.note, { paddingVertical: 6 }]}>{empty}</Text>
      ) : (
        tasks.map((task) => <TaskRow key={task.id} theme={theme} task={task} firstQueued={task.id === firstQueuedId} now={now} onOpenChat={openChat} />)
      )}
    </View>
  );

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, gap: 16 }}>
      <View style={styles.card} accessible accessibilityLabel={`${busySlots} of ${snapshot.slotLimit} slots busy on ${snapshot.hostLabel}, ${free} free`}>
        <Text style={styles.title}>
          Slots on {snapshot.hostLabel}: {busySlots} of {snapshot.slotLimit} busy
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {snapshot.holders.map((holder) => (
            <Pill key={holder.agentId} theme={theme} label={`${holder.title}: ${STATUS_LABEL[holder.status]}`} color={statusColor(theme, holder.status)} />
          ))}
          {Array.from({ length: free }, (_, index) => (
            <Pill key={`free-${index}`} theme={theme} label="Free" color={theme.colors.border} />
          ))}
        </View>
        <Text style={styles.note}>
          Working, waiting on you and stuck agents hold a slot. A queue run that changes no files for {snapshot.unattendedStopMinutes} min is stopped to free
          its slot. Change both in Settings, Plugins, Mission Control, Queue.
        </Text>
        {!snapshot.dispatcherReady ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
            Starting up: queued tasks start once Mission Control has connected to Paseo on this host.
          </Text>
        ) : null}
      </View>

      {snapshot.catalogError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{snapshot.catalogError}</Text> : null}

      {adding ? (
        <AddTaskForm theme={theme} snapshot={snapshot} onDone={() => setAdding(false)} />
      ) : (
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} primary label="Add task" onPress={() => setAdding(true)} />
        </View>
      )}

      {section("Queued", queued, "Nothing queued. Tasks start in order as slots free up.")}
      {section("Running", live, "No queue runs right now.")}
      {section("Last 24 hours", done, "No finished queue runs yet.")}
      <Text style={styles.note}>The queue is per host. Open Mission Control on another host to queue work there.</Text>
    </ScrollView>
  );
}
