/**
 * Settings, Plugins, Mission Control, Chat tab: summary card on or off, test and edit cards on or off,
 * quick replies on or off,
 * the reply list, the check command patterns and the saved prompts. Stored per host through
 * `registerSettings`.
 */
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { DEFAULT_CHAT_SETTINGS, chatSettings, type ChatSettings } from "../shared/chat";
import { formatPrompts, parsePrompts } from "../shared/prompts";
import { formatReplies, parsePatterns, parseReplies } from "./chat-format";
import { MONO } from "./parts";

/**
 * A multi-line text field in a settings card. Paseo's SettingsInput is one line in 0.17.4, which
 * joined the reply lines together, so lists are edited here.
 */
function MultilineField(props: {
  theme: PluginSurfaceProps["theme"];
  label: string;
  hint: string;
  error: string | null;
  value: string;
  minHeight: number;
  onChangeText(text: string): void;
}) {
  const { theme } = props;
  return (
    <View style={{ gap: 6, paddingHorizontal: 16, paddingVertical: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{props.label}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{props.hint}</Text>
      <TextInput
        style={{
          borderWidth: 1,
          borderColor: props.error ? theme.colors.statusDanger : theme.colors.border,
          borderRadius: 8,
          padding: 8,
          minHeight: props.minHeight,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface2,
          fontFamily: MONO,
          fontSize: 13,
          textAlignVertical: "top",
        }}
        multiline
        value={props.value}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={props.onChangeText}
        accessibilityLabel={props.label}
      />
      {props.error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }} accessibilityRole="alert">
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

export function ChatSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(chatSettings);
  const [draft, setDraft] = useState<{ replies: string; patterns: string; prompts: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [promptMessage, setPromptMessage] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status === "ready" && draft === null) {
      setDraft({
        replies: formatReplies(settings.values.replies),
        patterns: settings.values.checkPatterns.join(", "),
        prompts: formatPrompts(settings.values.prompts),
      });
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

  async function saveNow(values: ChatSettings, done: string, report: (text: string) => void = setMessage): Promise<void> {
    const saved = await ready.save(values, ready.revision);
    report(saved ? done : ready.saveError ? String(ready.saveError) : "Not saved: the settings changed elsewhere.");
  }

  const replies = parseReplies(draft.replies);
  const patterns = parsePatterns(draft.patterns);
  const patternError = patterns.length === 0 ? "Add at least one pattern." : patterns.some((p) => p.length > 80) ? "Patterns are at most 80 characters." : null;
  const valid = replies.error === null && replies.replies.length > 0 && patternError === null;
  const dirty =
    formatReplies(ready.values.replies) !== formatReplies(replies.replies) ||
    ready.values.checkPatterns.join("\n") !== patterns.join("\n");
  const prompts = parsePrompts(draft.prompts);
  const promptsError = prompts.error ?? (prompts.prompts.length === 0 ? "Add at least one prompt." : null);
  const promptsDirty = formatPrompts(ready.values.prompts) !== formatPrompts(prompts.prompts);

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
      <SettingsSection
        title="Test and edit cards"
        info="A finished test command shows as a card with only the failing tests. A file edit shows as a card with the first lines of its diff. Both read only what the agent's own tool call returned. Output Mission Control can't read keeps Paseo's normal row."
      >
        <SettingsCard>
          <SettingsSwitch
            label="Show test cards"
            hint="Uses the check commands above."
            value={ready.values.testCards}
            onValueChange={(testCards) => void saveNow({ ...ready.values, testCards }, testCards ? "Test cards on." : "Test cards off. Reopen a chat to see the change.")}
          />
          <SettingsSwitch
            label="Show edit cards"
            value={ready.values.editCards}
            onValueChange={(editCards) => void saveNow({ ...ready.values, editCards }, editCards ? "Edit cards on." : "Edit cards off. Reopen a chat to see the change.")}
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
          <MultilineField
            theme={theme}
            label="Replies"
            hint={'One per line, "Label = text". Up to 8.'}
            error={replies.error ?? (replies.replies.length === 0 ? "Add at least one reply." : null)}
            value={draft.replies}
            minHeight={110}
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
              setDraft((current) =>
                current
                  ? {
                      ...current,
                      replies: formatReplies(DEFAULT_CHAT_SETTINGS.replies),
                      patterns: DEFAULT_CHAT_SETTINGS.checkPatterns.join(", "),
                    }
                  : current,
              );
              void saveNow(
                { ...ready.values, replies: DEFAULT_CHAT_SETTINGS.replies, checkPatterns: DEFAULT_CHAT_SETTINGS.checkPatterns },
                "Defaults restored.",
              );
            }}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        title="Saved prompts"
        info="A Prompts pill above the message box, and /p name in the message box. Both put the prompt in the box with {branch}, {workspace} and {agent} filled in. They never send it."
      >
        <SettingsCard>
          <SettingsSwitch
            label="Show the Prompts pill and /p"
            value={ready.values.savedPrompts}
            onValueChange={(savedPrompts) =>
              void saveNow({ ...ready.values, savedPrompts }, savedPrompts ? "Saved prompts on." : "Saved prompts off.", setPromptMessage)
            }
          />
          <MultilineField
            theme={theme}
            label="Prompts"
            hint="Start each prompt with a line like /review. The lines below it, up to the next /name line, are its text. Up to 20."
            error={promptsError}
            value={draft.prompts}
            minHeight={220}
            onChangeText={(promptsText) => {
              setPromptMessage(null);
              setDraft((current) => (current ? { ...current, prompts: promptsText } : current));
            }}
          />
          <SettingsAction
            label={promptMessage ?? (promptsDirty ? "Unsaved changes" : `${ready.values.prompts.length} saved on this host`)}
            actionLabel="Save"
            disabled={promptsError !== null || !promptsDirty || ready.saving}
            onPress={() => void saveNow({ ...ready.values, prompts: prompts.prompts }, "Saved.", setPromptMessage)}
          />
          <SettingsAction
            label="Restore the default prompts: review, tdd, bugfix, docs"
            actionLabel="Restore"
            onPress={() => {
              setDraft((current) => (current ? { ...current, prompts: formatPrompts(DEFAULT_CHAT_SETTINGS.prompts) } : current));
              void saveNow({ ...ready.values, prompts: DEFAULT_CHAT_SETTINGS.prompts }, "Defaults restored.", setPromptMessage);
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
