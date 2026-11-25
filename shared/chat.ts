/**
 * Contracts for the chat features: the turn summary card and quick reply pills. Plain Zod values
 * only: this module is imported by both the daemon and the app.
 */
import { defineSettings, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** Timeline renderer kind and version for the turn summary card. */
export const SUMMARY_KIND = "turn-summary";
export const SUMMARY_VERSION = 1;

export const QuickReplySchema = z.object({
  /** Pill text. */
  label: z.string().trim().min(1).max(40),
  /** What the pill puts in the composer. */
  text: z.string().trim().min(1).max(2000),
});
export type QuickReply = z.output<typeof QuickReplySchema>;

export const DEFAULT_QUICK_REPLIES: QuickReply[] = [
  { label: "Continue", text: "Continue." },
  { label: "Run tests and fix", text: "Run the tests and fix any failures." },
  { label: "Commit", text: "Commit your changes with a clear message." },
  { label: "Explain the diff", text: "Explain the diff you made, file by file." },
];

/**
 * A saved prompt (PRD: Quick replies and saved prompts). `/p <name>` or the Prompts pill fills
 * {branch}, {workspace} and {agent} and puts the text in the composer. It is never sent.
 */
export const SavedPromptSchema = z.object({
  /** What follows `/p`. Lowercase letters, digits and hyphens. */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
  text: z.string().trim().min(1).max(4000),
});
export type SavedPrompt = z.output<typeof SavedPromptSchema>;

export const MAX_SAVED_PROMPTS = 20;

export const DEFAULT_SAVED_PROMPTS: SavedPrompt[] = [
  {
    name: "review",
    text: "Review the changes on {branch} before we merge. List bugs, risky edits and missing tests, file by file. Don't change any code yet.",
  },
  {
    name: "tdd",
    text: "Work test-first on {branch}: write a failing test for the next change, run it and show it failing, make it pass with the smallest change, then refactor. Run the tests after each step.",
  },
  {
    name: "bugfix",
    text: "Find the root cause before changing code: reproduce the bug, explain why it happens, then fix it on {branch} with a test that fails without the fix.\n\nThe bug:",
  },
  {
    name: "docs",
    text: "Update the docs for the changes on {branch}: the README, code comments and usage examples that are now out of date. Keep the wording short.",
  },
];

/** Commands that count as checks on the summary card. Matched against the start of each shell command. */
export const DEFAULT_CHECK_PATTERNS = [
  "go test",
  "go vet",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npx vitest",
  "vitest",
  "npx jest",
  "jest",
  "npx tsc",
  "tsc",
  "pytest",
  "python -m pytest",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "pnpm test",
  "yarn test",
  "bun test",
  "make test",
  "eslint",
  "ruff",
];

/**
 * Chat settings, one document per host (PRD: Sidebar and settings). The PRD puts quick replies on
 * the device, but Paseo 0.17.4 only lets a component read device settings (`useSettings`), not the
 * client entry that registers pills, so they are per host here.
 */
export const chatSettings = defineSettings({
  id: "chat",
  scope: "host",
  version: 1,
  schema: z.object({
    summaryCard: z.boolean().default(true),
    quickReplies: z.boolean().default(true),
    replies: z.array(QuickReplySchema).max(8).default(DEFAULT_QUICK_REPLIES),
    /** The Prompts pill and `/p`. Added after version 1 shipped; old documents read the defaults. */
    savedPrompts: z.boolean().default(true),
    prompts: z.array(SavedPromptSchema).max(MAX_SAVED_PROMPTS).default(DEFAULT_SAVED_PROMPTS),
    checkPatterns: z.array(z.string().trim().min(1).max(80)).max(50).default(DEFAULT_CHECK_PATTERNS),
  }),
});
export type ChatSettings = z.output<typeof chatSettings.schema>;
export const DEFAULT_CHAT_SETTINGS: ChatSettings = chatSettings.schema.parse({});

/** Streams the chat settings to the client entry, which registers the pills and `/p`. */
export const chatSettingsWatch = defineSubscription({
  name: "chat.settings.watch",
  input: z.object({}),
  event: z.object({
    quickReplies: z.boolean(),
    replies: z.array(QuickReplySchema),
    // Optional so an app still running the previous client bundle keeps parsing events.
    savedPrompts: z.boolean().default(true),
    prompts: z.array(SavedPromptSchema).default(DEFAULT_SAVED_PROMPTS),
  }),
});

export const SummaryFileSchema = z.object({
  path: z.string(),
  /** Null for binary files. */
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
  status: z.enum(["added", "modified", "deleted"]),
});
export type SummaryFile = z.output<typeof SummaryFileSchema>;

export const SummaryCheckSchema = z.object({
  command: z.string(),
  passed: z.boolean(),
  /** One line from the output the agent got: the first error when failed, a count line when passed. */
  line: z.string().nullable(),
});
export type SummaryCheck = z.output<typeof SummaryCheckSchema>;

export const TurnSummarySchema = z.object({
  agentId: z.string(),
  turnId: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  outcome: z.enum(["completed", "failed", "canceled"]),
  /** False when Mission Control had no snapshot from the start of the turn (it started mid-turn). */
  filesTracked: z.boolean(),
  /** Files changed since the turn started, from git. At most MAX_FILES; `moreFiles` counts the rest. */
  files: z.array(SummaryFileSchema),
  moreFiles: z.number().int().nonnegative(),
  totalAdded: z.number().int().nonnegative(),
  totalRemoved: z.number().int().nonnegative(),
  checks: z.array(SummaryCheckSchema),
  question: z.string().nullable(),
  /** Git trees before and after the turn, so `git diff --numstat <before> <after>` reproduces the list. */
  trees: z.object({ before: z.string(), after: z.string() }).nullable(),
});
export type TurnSummary = z.output<typeof TurnSummarySchema>;

/** Keeps the card well under Paseo's 64 KiB row limit. */
export const MAX_FILES = 200;
