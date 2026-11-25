import { describe, expect, it } from "vitest";
import { DEFAULT_SAVED_PROMPTS, chatSettings, chatSettingsWatch } from "../shared/chat";
import { expandPrompt, findPrompt, formatPrompts, parsePrompts } from "../shared/prompts";
import { rowBadges } from "../server/live/row-badges";

describe("expandPrompt", () => {
  it("fills branch, workspace and agent", () => {
    expect(expandPrompt("Review {branch} in {workspace} for {agent}.", { branch: "feat/x", workspace: "api", agent: "Fix login" })).toBe(
      "Review feat/x in api for Fix login.",
    );
  });
  it("uses words, not blanks, when a value is missing", () => {
    expect(expandPrompt("On {branch} in {workspace}, {agent}", { branch: null, workspace: " ", agent: null })).toBe(
      "On the current branch in this workspace, this agent",
    );
  });
  it("leaves other braces alone", () => {
    expect(expandPrompt("const a = {b}; {branch}", { branch: "main", workspace: null, agent: null })).toBe("const a = {b}; main");
  });
});

describe("findPrompt", () => {
  const prompts = DEFAULT_SAVED_PROMPTS;
  it("finds an exact name and ignores words after it", () => {
    expect(findPrompt(prompts, "review")).toMatchObject({ ok: true, prompt: { name: "review" } });
    expect(findPrompt(prompts, "  TDD  please")).toMatchObject({ ok: true, prompt: { name: "tdd" } });
  });
  it("finds a unique prefix", () => {
    expect(findPrompt(prompts, "rev")).toMatchObject({ ok: true, prompt: { name: "review" } });
  });
  it("explains an ambiguous prefix, an unknown name and a missing name", () => {
    const two = [...prompts, { name: "docs-api", text: "x" }];
    expect(findPrompt(two, "doc")).toEqual({ ok: false, message: '"doc" matches docs and docs-api. Type more of the name.' });
    expect(findPrompt(prompts, "nope")).toEqual({ ok: false, message: 'No saved prompt "nope". Saved: review, tdd, bugfix, docs.' });
    expect(findPrompt(prompts, "")).toMatchObject({ ok: false, message: "Name a saved prompt: /p review. Saved: review, tdd, bugfix, docs." });
    expect(findPrompt([], "x").ok).toBe(false);
  });
});

describe("settings text", () => {
  it("round-trips the defaults, including a blank line inside a prompt", () => {
    const text = formatPrompts(DEFAULT_SAVED_PROMPTS);
    expect(DEFAULT_SAVED_PROMPTS.find((p) => p.name === "bugfix")!.text).toContain("\n\nThe bug:");
    expect(parsePrompts(text)).toEqual({ prompts: DEFAULT_SAVED_PROMPTS, error: null });
  });
  it("reports bad names, empty prompts, duplicates and text before the first name", () => {
    expect(parsePrompts("/Review\nx").error).toMatch(/^Line 1: names are lowercase/);
    expect(parsePrompts("/a\n\n/b\ntext").error).toBe("Line 1: /a needs text, at most 4000 characters.");
    expect(parsePrompts("/a\nx\n/a\ny").error).toBe("Line 3: /a is used twice.");
    expect(parsePrompts("hello\n/a\nx").error).toBe("Line 1: start each prompt with a line like /review.");
    expect(parsePrompts("\n\n/a\n  x  \n\n").prompts).toEqual([{ name: "a", text: "x" }]);
  });
  it("caps the list at 20", () => {
    const text = Array.from({ length: 21 }, (_, i) => `/p${i}\ntext`).join("\n");
    expect(parsePrompts(text).error).toBe("At most 20 saved prompts.");
  });
});

describe("settings compatibility", () => {
  it("reads a document saved before saved prompts existed", () => {
    const old = { summaryCard: true, quickReplies: false, replies: [{ label: "Go", text: "Go." }], checkPatterns: ["npm test"] };
    const parsed = chatSettings.schema.parse(old);
    expect(parsed.savedPrompts).toBe(true);
    expect(parsed.prompts).toEqual(DEFAULT_SAVED_PROMPTS);
    expect(parsed.quickReplies).toBe(false);
  });
  it("accepts a settings event from an older server", () => {
    const parsed = chatSettingsWatch.event.parse({ quickReplies: true, replies: [] });
    expect(parsed.savedPrompts).toBe(true);
    expect(parsed.prompts).toHaveLength(4);
  });
});

describe("rowBadges", () => {
  const workspaceOf = (agentId: string) => ({ a1: "w1", a2: "w1", a3: "w2" })[agentId] ?? null;
  it("gives no badge to workspaces with nothing open", () => {
    expect(rowBadges([{ agentId: "a1", kind: "stuck", resolvedAt: 5 }], workspaceOf, 45)).toEqual({});
  });
  it("orders kinds by urgency, counts agents once, and labels over time with the limit", () => {
    const badges = rowBadges(
      [
        { agentId: "a1", kind: "stuck", resolvedAt: null },
        { agentId: "a2", kind: "stuck", resolvedAt: null },
        { agentId: "a1", kind: "permission", resolvedAt: null },
        { agentId: "a1", kind: "permission", resolvedAt: null },
        { agentId: "a3", kind: "overtime", resolvedAt: null },
        { agentId: "unknown", kind: "question", resolvedAt: null },
      ],
      workspaceOf,
      60,
    );
    expect(badges).toEqual({
      w1: [
        { kind: "permission", label: "approve", description: "Mission Control: 1 agent waiting for approval" },
        { kind: "stuck", label: "2 stuck", description: "Mission Control: 2 agents look stuck" },
      ],
      w2: [{ kind: "overtime", label: "over 60m", description: "Mission Control: 1 agent over the time limit" }],
    });
  });
});
