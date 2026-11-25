/**
 * The turn summary card, rendered in the agent's timeline from rows the server appends
 * (`timeline.append`, kind "turn-summary"). It only renders; the data comes from the daemon.
 *
 * Buttons: Answer the question puts a reply starter in the composer and focuses it. It never sends.
 * View changes from the PRD is left out: Paseo 0.17.4 gives timeline renderers no way to open the
 * Changes panel.
 */
import { useComposers, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { SummaryCheck, SummaryFile, TurnSummary } from "../shared/chat";
import { headline, replyStarter } from "./chat-format";
import { Button, Pill } from "./parts";

const FILES_SHOWN = 6;




const STATUS_TEXT: Record<SummaryFile["status"], string> = { added: "A", modified: "M", deleted: "D" };
const STATUS_WORD: Record<SummaryFile["status"], string> = { added: "added", modified: "modified", deleted: "deleted" };

export function SummaryCard({ item, theme, agentId }: PluginTimelineItemProps<TurnSummary>) {
  const summary = item.data;
  const [allFiles, setAllFiles] = useState(false);
  const [composer] = useComposers({ agentId });
  const [answerError, setAnswerError] = useState<string | null>(null);

  const styles = useMemo(
    () => ({
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
        marginVertical: 4,
      },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      section: { gap: 4 },
      label: { color: theme.colors.foregroundMuted, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.4 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: 20 },
      status: { color: theme.colors.foregroundMuted, fontSize: 12, width: 12, fontFamily: "monospace" },
      path: { color: theme.colors.foreground, fontSize: 12, flex: 1, fontFamily: "monospace" },
      added: { color: theme.colors.statusSuccess, fontSize: 12, fontFamily: "monospace" },
      removed: { color: theme.colors.statusDanger, fontSize: 12, fontFamily: "monospace" },
      command: { color: theme.colors.foreground, fontSize: 12, flex: 1, fontFamily: "monospace" },
      checkLine: { color: theme.colors.foregroundMuted, fontSize: 12, marginLeft: 4 },
      link: { color: theme.colors.accent, fontSize: 12 },
      question: { color: theme.colors.foreground, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme],
  );

  const files = allFiles ? summary.files : summary.files.slice(0, FILES_SHOWN);
  const hidden = summary.files.length - files.length + summary.moreFiles;

  async function answer(): Promise<void> {
    if (!composer || !summary.question) return;
    setAnswerError(null);
    try {
      composer.insertText(replyStarter(summary.question));
      await composer.focus();
    } catch (error) {
      setAnswerError(error instanceof Error ? error.message : "The composer is not available.");
    }
  }

  return (
    <View style={styles.card} accessible={false}>
      <View style={styles.row}>
        <Text style={styles.title}>Turn summary</Text>
        <Text style={styles.meta} numberOfLines={1} accessibilityLabel={`Turn summary: ${headline(summary)}`}>
          {headline(summary)}
        </Text>
      </View>

      {summary.filesTracked ? (
        summary.files.length > 0 ? (
          <View style={styles.section}>
            {files.map((file) => (
              <FileRow key={file.path} file={file} styles={styles} />
            ))}
            {hidden > 0 || allFiles ? (
              <Pressable accessibilityRole="button" onPress={() => setAllFiles((value) => !value)}>
                <Text style={styles.link}>
                  {allFiles
                    ? summary.moreFiles > 0
                      ? `Show fewer (${summary.moreFiles} more not listed)`
                      : "Show fewer"
                    : `Show all ${summary.files.length + summary.moreFiles} files`}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <Text style={styles.meta}>No files changed.</Text>
        )
      ) : (
        <Text style={styles.meta}>Files not tracked: Mission Control started during this turn.</Text>
      )}

      <View style={styles.section}>
        <Text style={styles.label}>Checks</Text>
        {summary.checks.length === 0 ? (
          <Text style={styles.meta}>No checks run</Text>
        ) : (
          summary.checks.map((check, index) => (
            <CheckRow key={`${index}:${check.command}`} check={check} theme={theme} styles={styles} />
          ))
        )}
      </View>

      {summary.question ? (
        <View style={styles.section}>
          <Text style={styles.label}>Open question</Text>
          <Text style={styles.question}>{summary.question}</Text>
          <View style={styles.row}>
            <Button theme={theme} label="Answer the question" onPress={() => void answer()} disabled={!composer} />
          </View>
          {answerError ? <Text style={styles.error}>{answerError}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

type Styles = Record<string, object>;

function FileRow({ file, styles }: { file: SummaryFile; styles: Styles }) {
  const counts =
    file.added === null ? "binary" : `+${file.added} −${file.removed ?? 0}`;
  return (
    <View style={styles.row} accessible accessibilityLabel={`${file.path}, ${STATUS_WORD[file.status]}, ${counts}`}>
      <Text style={styles.status}>{STATUS_TEXT[file.status]}</Text>
      <Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">
        {file.path}
      </Text>
      {file.added === null ? (
        <Text style={styles.status}>bin</Text>
      ) : (
        <>
          <Text style={styles.added}>+{file.added}</Text>
          <Text style={styles.removed}>−{file.removed ?? 0}</Text>
        </>
      )}
    </View>
  );
}

function CheckRow({ check, theme, styles }: { check: SummaryCheck; theme: TurnSummaryTheme; styles: Styles }) {
  return (
    <View style={{ gap: 2 }}>
      <View style={styles.row}>
        <Pill
          theme={theme}
          label={check.passed ? "Passed" : "Failed"}
          color={check.passed ? theme.colors.statusSuccess : theme.colors.statusDanger}
        />
        <Text style={styles.command} numberOfLines={1}>
          {check.command}
        </Text>
      </View>
      {check.line ? (
        <Text style={styles.checkLine} numberOfLines={2}>
          {check.line}
        </Text>
      ) : null}
    </View>
  );
}

type TurnSummaryTheme = PluginTimelineItemProps<TurnSummary>["theme"];
