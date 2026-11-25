/**
 * Settings, Plugins, Mission Control, Chat tab: summary card on or off, quick replies on or off,
 * the reply list and the check command patterns. Stored per host through `registerSettings`.
 */
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { DEFAULT_CHAT_SETTINGS, chatSettings, type ChatSettings } from "../shared/chat";
import { formatReplies, parsePatterns, parseReplies } from "./chat-format";




export function ChatSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(chatSettings);
  const [draft, setDraft] = useState<{ replies: string; patterns: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status === "ready" && draft === null) {
      setDraft({ replies: formatReplies(settings.values.replies), patterns: settings.values.checkPatterns.join(", ") });
    }
  }, [settings, draft]);

  if (settings.status === "invalid" || settings.status === "error") {
    return (
      <SettingsSection title="Chat">
        <SettingsCard>
          <SettingsAction
            label="Saved settings could not be read"
            hint={String(settings.error)}
            actionLabel="Reset to defaults"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (settings.status !== "ready" || draft === null) {
    return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  }
  const ready = settings;

  async function saveNow(values: ChatSettings, done: string): Promise<void> {
    const saved = await ready.save(values, ready.revision);
    setMessage(saved ? done : ready.saveError ? String(ready.saveError) : "Not saved: the settings changed elsewhere.");
  }

  const replies = parseReplies(draft.replies);
  const patterns = parsePatterns(draft.patterns);
  const patternError = patterns.length === 0 ? "Add at least one pattern." : patterns.some((p) => p.length > 80) ? "Patterns are at most 80 characters." : null;
  const valid = replies.error === null && replies.replies.length > 0 && patternError === null;
  const dirty =
    formatReplies(ready.values.replies) !== formatReplies(replies.replies) ||
    ready.values.checkPatterns.join("\n") !== patterns.join("\n");

  return (
    <>
      <SettingsSection title="Turn summary card" info="Added at the end of a turn that changed files or ran checks. Checks come only from commands the agent ran.">
        <SettingsCard>
          <SettingsSwitch
            label="Show turn summary cards"
            value={ready.values.summaryCard}
            onValueChange={(summaryCard) => void saveNow({ ...ready.values, summaryCard }, summaryCard ? "Summary cards on from the next turn." : "Summary cards off.")}
          />
          <SettingsInput
            label="Check commands"
            hint="Comma-separated. A shell command starting with one of these counts as a check."
            error={patternError ?? undefined}
            initialValue={draft.patterns}
            onChangeText={(patternsText) => {
              setMessage(null);
              setDraft((current) => (current ? { ...current, patterns: patternsText } : current));
            }}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Quick replies" info="Pills above the message box. They put text in the box and never send it.">
        <SettingsCard>
          <SettingsSwitch
            label="Show quick reply pills"
            value={ready.values.quickReplies}
            onValueChange={(quickReplies) => void saveNow({ ...ready.values, quickReplies }, quickReplies ? "Quick replies on." : "Quick replies off.")}
          />
          <SettingsInput
            label="Replies"
            hint={'One per line, "Label = text". Up to 8.'}
            error={replies.error ?? (replies.replies.length === 0 ? "Add at least one reply." : undefined)}
            initialValue={draft.replies}
            onChangeText={(repliesText) => {
              setMessage(null);
              setDraft((current) => (current ? { ...current, replies: repliesText } : current));
            }}
          />
          <SettingsAction
            label={message ?? (dirty ? "Unsaved changes" : "Saved per host")}
            actionLabel="Save"
            disabled={!valid || !dirty || ready.saving}
            onPress={() =>
              void saveNow({ ...ready.values, replies: replies.replies, checkPatterns: patterns }, "Saved.")
            }
          />
          <SettingsAction
            label="Restore the default replies and checks"
            actionLabel="Restore"
            onPress={() => {
              setDraft({
                replies: formatReplies(DEFAULT_CHAT_SETTINGS.replies),
                patterns: DEFAULT_CHAT_SETTINGS.checkPatterns.join(", "),
              });
              void saveNow(
                { ...ready.values, replies: DEFAULT_CHAT_SETTINGS.replies, checkPatterns: DEFAULT_CHAT_SETTINGS.checkPatterns },
                "Defaults restored.",
              );
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
