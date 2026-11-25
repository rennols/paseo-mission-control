/**
 * One Needs you card. Every action is a click that calls one RPC; nothing is answered or sent on
 * the user's behalf. Resolved cards collapse to one line saying what happened.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { dismissNeed, extendTime, respondPermission, sendHint, type ActionResult, type NeedsItem } from "../shared/live";
import { EXTEND_MINUTES } from "../shared/settings";
import { Button, FONT, MONO, Pill, cardStyle, formatElapsed } from "./parts";
import { optionLabel, presentRequest, relativeToCwd } from "./ui-format";

const KIND_LABEL: Record<NeedsItem["kind"], string> = {
  stuck: "Stuck",
  permission: "Approve",
  question: "Question",
  overtime: "Over time",
  collision: "Collision",
};

function kindColor(theme: PluginTheme, kind: NeedsItem["kind"]): string {
  if (kind === "stuck") return theme.colors.statusDanger;
  if (kind === "overtime") return theme.colors.accent;
  return theme.colors.statusWarning;
}

/** Cards with a Send a hint box: the hint becomes the agent's next prompt, sent on click. */
function hintable(item: NeedsItem): boolean {
  return item.kind === "stuck" || item.kind === "collision";
}

export function NeedsCard({
  theme,
  item,
  now,
  onOpenChat,
}: {
  theme: PluginTheme;
  item: NeedsItem;
  now: number;
  onOpenChat: ((agentId: string) => void) | null;
}) {
  const toast = useToast();
  const respond = useRpc(respondPermission);
  const hint = useRpc(sendHint);
  const dismiss = useRpc(dismissNeed);
  const extend = useRpc(extendTime);
  const [busy, setBusy] = useState<string | null>(null);
  const [hintOpen, setHintOpen] = useState(false);
  const [hintText, setHintText] = useState("");
  const cwd = useAgent(item.agentId, (agent) => agent.cwd);

  const styles = useMemo(
    () => ({
      card: { ...cardStyle(theme), borderLeftWidth: 3, borderLeftColor: kindColor(theme, item.kind) },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      agent: { color: theme.colors.foreground, fontWeight: "600" as const, fontSize: FONT.row, flexShrink: 1, minWidth: 0 },
      age: { color: theme.colors.foregroundMuted, fontSize: FONT.meta, marginLeft: "auto" as const, flexShrink: 0 },
      title: { color: theme.colors.foreground, fontSize: FONT.body, lineHeight: 19 },
      code: {
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      detail: { color: theme.colors.foreground, fontSize: FONT.meta, lineHeight: 18, fontFamily: MONO },
      option: { color: theme.colors.foregroundMuted, fontSize: FONT.body, lineHeight: 19 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      request: { gap: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: theme.colors.border },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 8,
        minHeight: 60,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        textAlignVertical: "top" as const,
      },
      resolved: { flexDirection: "row" as const, gap: 8, paddingVertical: 6, paddingHorizontal: 4 },
      resolvedText: { color: theme.colors.foregroundMuted, fontSize: FONT.meta, lineHeight: 17, flexShrink: 1 },
    }),
    [theme, item.kind],
  );

  async function run(key: string, action: () => Promise<ActionResult>): Promise<void> {
    setBusy(key);
    try {
      const result = await action();
      if (!result.ok) toast.error(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  if (item.resolvedAt !== null) {
    return (
      <View style={styles.resolved} accessible accessibilityLabel={`${item.agentTitle}: ${item.resolution ?? "Resolved"}`}>
        <Text style={[styles.resolvedText, { color: theme.colors.statusSuccess }]}>✓</Text>
        <Text style={styles.resolvedText} numberOfLines={2}>
          <Text style={{ color: theme.colors.foreground }}>{item.agentTitle}</Text>: {item.resolution ?? "Resolved."}
        </Text>
      </View>
    );
  }

  // A question is answered in the chat, so there it is the main button. Elsewhere it is for context.
  const answerInChat = item.kind === "question";
  const openChat = onOpenChat ? (
    <Button
      theme={theme}
      primary={answerInChat}
      label={answerInChat ? "Answer in chat" : "Open chat"}
      onPress={() => onOpenChat(item.agentId)}
      accessibilityLabel={answerInChat ? `Answer ${item.agentTitle} in its chat` : `Open chat with ${item.agentTitle}`}
    />
  ) : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Pill theme={theme} label={KIND_LABEL[item.kind]} color={kindColor(theme, item.kind)} />
        <Text style={styles.agent} numberOfLines={1}>
          {item.agentTitle}
        </Text>
        <Text style={styles.age}>{formatElapsed(now - item.openedAt)} ago</Text>
      </View>

      {item.kind === "permission" ? (
        item.requests.map((request, index) => {
          const shown = presentRequest(relativeToCwd(request.title, cwd), request.detail === null ? null : relativeToCwd(request.detail, cwd));
          return (
            <View key={request.requestId} style={index === 0 ? { gap: 6 } : styles.request}>
              <Text style={styles.title} numberOfLines={4}>
                {shown.title}
              </Text>
              {shown.detail ? (
                <View style={styles.code}>
                  <Text style={styles.detail} numberOfLines={6}>
                    {shown.detail}
                  </Text>
                </View>
              ) : null}
              <View style={styles.actions}>
                <Button
                  theme={theme}
                  primary
                  label="Allow once"
                  busy={busy === `allow-${request.requestId}`}
                  disabled={busy !== null}
                  accessibilityLabel={`Allow once: ${request.title}`}
                  onPress={() => void run(`allow-${request.requestId}`, () => respond({ itemId: item.id, requestId: request.requestId, decision: "allow" }))}
                />
                <Button
                  theme={theme}
                  danger
                  label="Deny"
                  busy={busy === `deny-${request.requestId}`}
                  disabled={busy !== null}
                  accessibilityLabel={`Deny: ${request.title}`}
                  onPress={() => void run(`deny-${request.requestId}`, () => respond({ itemId: item.id, requestId: request.requestId, decision: "deny" }))}
                />
                {index === item.requests.length - 1 ? openChat : null}
              </View>
            </View>
          );
        })
      ) : (
        <>
          <Text style={styles.title} numberOfLines={4}>
            {item.title}
          </Text>
          {item.detail ? (
            <View style={styles.code}>
              <Text style={styles.detail} numberOfLines={3}>
                {item.detail}
              </Text>
            </View>
          ) : null}
          {item.options.length > 0 ? (
            <View style={{ gap: 4 }} accessibilityLabel={`${item.options.length} options`}>
              {item.options.map((option, index) => (
                <Text key={option.label} style={styles.option}>
                  <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{optionLabel(index, option.label)}</Text>
                  {option.description ? ` — ${option.description}` : ""}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      )}

      {hintable(item) && hintOpen ? (
        <View style={{ gap: 8 }}>
          <TextInput
            style={styles.input}
            multiline
            autoFocus
            value={hintText}
            onChangeText={setHintText}
            placeholder={item.kind === "collision" ? "Tell the agent how to avoid the overlap" : "Tell the agent what to try instead"}
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={`Hint for ${item.agentTitle}`}
          />
          <View style={styles.actions}>
            <Button
              theme={theme}
              primary
              label="Send hint"
              busy={busy === "hint"}
              disabled={hintText.trim().length === 0}
              onPress={() => void run("hint", () => hint({ itemId: item.id, text: hintText.trim() }))}
            />
            <Button theme={theme} label="Cancel" onPress={() => setHintOpen(false)} />
          </View>
        </View>
      ) : null}

      {item.kind !== "permission" && !(hintable(item) && hintOpen) ? (
        <View style={styles.actions}>
          {hintable(item) ? <Button theme={theme} primary label="Send a hint" onPress={() => setHintOpen(true)} /> : null}
          {item.kind === "overtime" ? (
            <Button
              theme={theme}
              primary
              label={`Allow ${EXTEND_MINUTES} more min`}
              busy={busy === "extend"}
              onPress={() => void run("extend", () => extend({ itemId: item.id }))}
            />
          ) : null}
          {openChat}
          {item.kind === "stuck" || item.kind === "collision" || (item.kind === "question" && item.questionSource === "text") ? (
            <Button
              theme={theme}
              label="Dismiss"
              busy={busy === "dismiss"}
              accessibilityLabel={`Dismiss: ${item.title}`}
              onPress={() => void run("dismiss", () => dismiss({ itemId: item.id }))}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
