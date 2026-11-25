/**
 * Saved prompts: lookup, placeholder filling and the settings text format. Pure functions, shared
 * by the composer pill, `/p` and the settings screen, and unit-tested without React Native.
 */
import { MAX_SAVED_PROMPTS, SavedPromptSchema, type SavedPrompt } from "./chat";

export interface PromptContext {
  branch: string | null;
  workspace: string | null;
  agent: string | null;
}

/** Words used when Paseo has no value, so the inserted prompt still reads as a sentence. */
const FALLBACK: Record<keyof PromptContext, string> = {
  branch: "the current branch",
  workspace: "this workspace",
  agent: "this agent",
};

/** Fills {branch}, {workspace} and {agent}. Other braces are left as they are. */
export function expandPrompt(text: string, context: PromptContext): string {
  return text.replace(/\{(branch|workspace|agent)\}/g, (_match, key: keyof PromptContext) => {
    const value = context[key]?.trim();
    return value ? value : FALLBACK[key];
  });
}

export type PromptLookup =
  | { ok: true; prompt: SavedPrompt }
  | { ok: false; message: string };

/**
 * Finds the prompt `/p <args>` names: an exact name first, then a name the words start (`/p rev`).
 * Anything after the name is ignored. Errors are written for the toast Paseo shows.
 */
export function findPrompt(prompts: readonly SavedPrompt[], args: string): PromptLookup {
  const names = prompts.map((prompt) => prompt.name).join(", ");
  if (prompts.length === 0) return { ok: false, message: "No saved prompts. Add some under Settings, Plugins, Mission Control, Chat." };
  const wanted = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!wanted) return { ok: false, message: `Name a saved prompt: /p ${prompts[0]!.name}. Saved: ${names}.` };
  const exact = prompts.find((prompt) => prompt.name === wanted);
  if (exact) return { ok: true, prompt: exact };
  const starts = prompts.filter((prompt) => prompt.name.startsWith(wanted));
  if (starts.length === 1) return { ok: true, prompt: starts[0]! };
  if (starts.length > 1) return { ok: false, message: `"${wanted}" matches ${starts.map((p) => p.name).join(" and ")}. Type more of the name.` };
  return { ok: false, message: `No saved prompt "${wanted}". Saved: ${names}.` };
}

/**
 * Settings text: each prompt starts with a line "/name"; the lines after it, up to the next
 * "/name" line, are its text. Blank lines inside a prompt are kept; blank lines around it are not.
 */
export function formatPrompts(prompts: readonly SavedPrompt[]): string {
  return prompts.map((prompt) => `/${prompt.name}\n${prompt.text}`).join("\n\n");
}

export function parsePrompts(text: string): { prompts: SavedPrompt[]; error: string | null } {
  const prompts: SavedPrompt[] = [];
  const lines = text.split(/\r?\n/);
  let current: { name: string; line: number; body: string[] } | null = null;

  const finish = (): string | null => {
    if (!current) return null;
    const parsed = SavedPromptSchema.safeParse({ name: current.name, text: current.body.join("\n") });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue?.path[0] === "name") return `Line ${current.line}: names are lowercase letters, digits and hyphens, up to 30, starting with a letter.`;
      return `Line ${current.line}: /${current.name} needs text, at most 4000 characters.`;
    }
    if (prompts.some((prompt) => prompt.name === parsed.data.name)) return `Line ${current.line}: /${current.name} is used twice.`;
    prompts.push(parsed.data);
    return null;
  };

  for (const [index, line] of lines.entries()) {
    const header = /^\/(\S+)\s*$/.exec(line.trim());
    if (header) {
      const error = finish();
      if (error) return { prompts, error };
      current = { name: header[1]!, line: index + 1, body: [] };
      continue;
    }
    if (!current) {
      if (line.trim()) return { prompts, error: `Line ${index + 1}: start each prompt with a line like /review.` };
      continue;
    }
    current.body.push(line);
  }
  const error = finish();
  if (error) return { prompts, error };
  if (prompts.length > MAX_SAVED_PROMPTS) return { prompts, error: `At most ${MAX_SAVED_PROMPTS} saved prompts.` };
  return { prompts, error: null };
}
