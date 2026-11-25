/**
 * Test and edit cards (PRD: Chat, Test and edit cards). A timeline transformer swaps a finished
 * test command or file edit for a card; the parsing is in shared/tool-cards.ts. Settings (on/off and
 * the check command patterns) come from the server through `chat.settings.watch`.
 *
 * Paseo memoises transformer results per row, so a settings change shows on rows that arrive
 * after it; rows already on screen change when the chat is opened again.
 */
import { useAgent, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { DEFAULT_CHAT_SETTINGS, chatSettingsWatch } from "../shared/chat";
import {
  EDIT_CARD_KIND,
  EDIT_CARD_VERSION,
  EDIT_LINES_SHOWN,
  EditCardSchema,
  TEST_CARD_KIND,
  TEST_CARD_VERSION,
  TestCardSchema,
  displayPath,
  keepIndent,
  testSummaryText,
  toolCardFor,
  type EditCard,
  type TestCard,
  type ToolCardConfig,
} from "../shared/tool-cards";
import { MONO, Pill } from "./parts";

type Theme = PluginTimelineItemProps["theme"];

function useCardStyles(theme: Theme) {
  return useMemo(
    () => ({
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
        marginVertical: 2,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: 20, flexWrap: "wrap" as const },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      mono: { color: theme.colors.foreground, fontSize: 12, fontFamily: MONO, flexShrink: 1 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      failName: { color: theme.colors.foreground, fontSize: 12, fontFamily: MONO },
      failLine: { color: theme.colors.foregroundMuted, fontSize: 12, marginLeft: 10 },
      link: { color: theme.colors.accent, fontSize: 12 },
      output: {
        color: theme.colors.foreground,
        fontSize: 11,
        fontFamily: MONO,
        backgroundColor: theme.colors.surface2,
        padding: 8,
        borderRadius: 6,
      },
      added: { color: theme.colors.statusSuccess, fontSize: 12, fontFamily: MONO },
      removed: { color: theme.colors.statusDanger, fontSize: 12, fontFamily: MONO },
      diff: { borderRadius: 6, overflow: "hidden" as const, backgroundColor: theme.colors.surface2 },
      diffLine: { fontSize: 11, fontFamily: MONO, paddingHorizontal: 8, color: theme.colors.foreground },
    }),
    [theme],
  );
}

export function TestCardView({ item, theme }: PluginTimelineItemProps<TestCard>) {
  const card = item.data;
  const styles = useCardStyles(theme);
  const [showOutput, setShowOutput] = useState(false);
  const summary = testSummaryText(card);
  const verdict = card.passed ? "Passed" : "Failed";

  return (
    <View style={styles.card}>
      <View style={styles.row} accessible accessibilityLabel={`Test run ${verdict.toLowerCase()}: ${card.command}${summary ? `, ${summary}` : ""}`}>
        <Pill theme={theme} label={verdict} color={card.passed ? theme.colors.statusSuccess : theme.colors.statusDanger} />
        <Text style={styles.mono} numberOfLines={2}>
          {card.command}
        </Text>
      </View>
      {summary ? <Text style={styles.meta}>{summary}</Text> : null}

      {card.failures.length > 0 ? (
        <View style={{ gap: 4 }}>
          {card.failures.map((failure) => (
            <View key={failure.name} accessible accessibilityLabel={`Failed: ${failure.name}${failure.line ? `. ${failure.line}` : ""}`}>
              <Text style={styles.failName} numberOfLines={2}>
                ✕ {failure.name}
              </Text>
              {failure.line ? (
                <Text style={styles.failLine} numberOfLines={2}>
                  {failure.line}
                </Text>
              ) : null}
            </View>
          ))}
          {card.moreFailures > 0 ? <Text style={styles.meta}>{card.moreFailures} more failing tests in the output</Text> : null}
        </View>
      ) : null}

      {card.output ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showOutput }} onPress={() => setShowOutput((value) => !value)}>
          <Text style={styles.link}>{showOutput ? "Hide output" : "Show full output"}</Text>
        </Pressable>
      ) : null}
      {showOutput ? (
        <ScrollView style={{ maxHeight: 420 }} nestedScrollEnabled>
          {card.outputCut > 0 ? <Text style={styles.meta}>The first {card.outputCut.toLocaleString()} characters are left out.</Text> : null}
          <Text style={styles.output} selectable>
            {card.output}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const MARK: Record<EditCard["lines"][number]["kind"], string> = { add: "+", del: "−", ctx: " ", gap: "" };

export function EditCardView({ item, theme, agentId }: PluginTimelineItemProps<EditCard>) {
  const card = item.data;
  const cwd = useAgent(agentId, (agent) => agent.cwd);
  const path = displayPath(card.path, cwd);
  const styles = useCardStyles(theme);
  const [all, setAll] = useState(false);
  const lines = all ? card.lines : card.lines.slice(0, EDIT_LINES_SHOWN);
  const hidden = card.lines.length - lines.length + card.moreLines;
  const counts = card.mode === "write" ? `wrote ${card.added} lines` : `+${card.added} −${card.removed}`;

  return (
    <View style={styles.card}>
      <View style={styles.row} accessible accessibilityLabel={`${card.mode === "write" ? "Wrote" : "Edited"} ${path}, ${card.added} lines added, ${card.removed} removed`}>
        <Text style={styles.label}>{card.mode === "write" ? "Write" : "Edit"}</Text>
        <Text style={[styles.mono, { flex: 1 }]} numberOfLines={1} ellipsizeMode="head">
          {path}
        </Text>
        {card.mode === "write" ? (
          <Text style={styles.meta}>{counts}</Text>
        ) : (
          <>
            <Text style={styles.added}>+{card.added}</Text>
            <Text style={styles.removed}>−{card.removed}</Text>
          </>
        )}
      </View>
      <View style={styles.diff}>
        {lines.map((line, index) => (
          <DiffRow key={index} line={line} theme={theme} style={styles.diffLine} />
        ))}
      </View>
      {hidden > 0 || all ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: all }} onPress={() => setAll((value) => !value)}>
          <Text style={styles.link}>
            {all
              ? card.moreLines > 0
                ? `Show fewer (${card.moreLines} more lines not kept)`
                : "Show fewer"
              : `Show all lines (${hidden} more)`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DiffRow({ line, theme, style }: { line: EditCard["lines"][number]; theme: Theme; style: object }) {
  if (line.kind === "gap") {
    return (
      <Text style={[style, { color: theme.colors.foregroundMuted }]} accessibilityLabel="Unchanged lines left out">
        ⋯
      </Text>
    );
  }
  const tint = line.kind === "add" ? theme.colors.statusSuccess : line.kind === "del" ? theme.colors.statusDanger : null;
  const word = line.kind === "add" ? "Added" : line.kind === "del" ? "Removed" : "Unchanged";
  // The + and − marks carry the meaning; the tint only repeats it.
  return (
    <View accessible accessibilityLabel={`${word}: ${line.text}`}>
      {tint ? <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: tint, opacity: 0.14 }} /> : null}
      <Text style={style} numberOfLines={1}>
        {MARK[line.kind]} {keepIndent(line.text)}
      </Text>
    </View>
  );
}

export function startToolCards(client: PluginClientContext): () => void {
  // Defaults until the server's settings arrive, so the first rows already get cards.
  const config: ToolCardConfig = {
    testCards: DEFAULT_CHAT_SETTINGS.testCards,
    editCards: DEFAULT_CHAT_SETTINGS.editCards,
    checkPatterns: DEFAULT_CHAT_SETTINGS.checkPatterns,
  };
  const removers = [
    client.subscribe(chatSettingsWatch, {}, (event) => {
      config.testCards = event.testCards;
      config.editCards = event.editCards;
      config.checkPatterns = event.checkPatterns;
    }),
    client.addTimelineTransformer({
      id: "tool-cards",
      query: { itemType: "tool_call" },
      transform: ({ item, phase }) => toolCardFor(item, phase, config),
    }),
    client.addTimelineRenderer({ kind: TEST_CARD_KIND, version: TEST_CARD_VERSION, schema: TestCardSchema, Component: TestCardView }),
    client.addTimelineRenderer({ kind: EDIT_CARD_KIND, version: EDIT_CARD_VERSION, schema: EditCardSchema, Component: EditCardView }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
