/**
 * Pure helpers for the chat surfaces (summary card text, settings text), kept out of the React
 * modules so they can be unit-tested without React Native.
 */
import { QuickReplySchema, type QuickReply, type TurnSummary } from "../shared/chat";

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The card's header line, also its screen reader label. */
export function headline(summary: TurnSummary): string {
  const parts = [formatDuration(summary.endedAt - summary.startedAt)];
  const fileCount = summary.files.length + summary.moreFiles;
  if (summary.filesTracked) {
    parts.push(fileCount === 1 ? "1 file changed" : `${fileCount} files changed`);
    if (fileCount > 0) parts.push(`+${summary.totalAdded} −${summary.totalRemoved}`);
  }
  if (summary.outcome !== "completed") parts.push(summary.outcome === "failed" ? "Turn failed" : "Turn canceled");
  return parts.join(" · ");
}

/** What "Answer the question" puts in the composer. */
export function replyStarter(question: string): string {
  return `> ${question.replace(/\s+/g, " ").trim()}\n\n`;
}

/** One reply per line, "Label = text". A line without "=" uses the same words for both. */
export function parseReplies(text: string): { replies: QuickReply[]; error: string | null } {
  const replies: QuickReply[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const at = line.indexOf("=");
    const label = (at === -1 ? line : line.slice(0, at)).trim();
    const body = (at === -1 ? line : line.slice(at + 1)).trim();
    const parsed = QuickReplySchema.safeParse({ label, text: body });
    if (!parsed.success) return { replies, error: `Line ${index + 1}: labels are 1 to 40 characters, text 1 to 2000.` };
    replies.push(parsed.data);
  }
  if (replies.length > 8) return { replies, error: "At most 8 quick replies." };
  return { replies, error: null };
}

export function formatReplies(replies: readonly QuickReply[]): string {
  return replies.map((reply) => (reply.label === reply.text ? reply.label : `${reply.label} = ${reply.text}`)).join("\n");
}

export function parsePatterns(text: string): string[] {
  return text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
}
