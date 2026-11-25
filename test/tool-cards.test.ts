import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_SETTINGS } from "../shared/chat";
import { diffFromContent, diffFromStrings, diffFromUnified } from "../shared/edit-diff";
import { parseTestOutput } from "../shared/test-output";
import { displayPath, durationText, editCard, keepIndent, testCard, testSummaryText, toolCardFor, type ToolCardConfig } from "../shared/tool-cards";

/** Real output from each runner, failing 1 of 2 or 3 tests (test/fixtures/runners). */
const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", "runners", name), "utf8");
const patterns = DEFAULT_CHAT_SETTINGS.checkPatterns;
const config: ToolCardConfig = { testCards: true, editCards: true, checkPatterns: patterns };

const shell = (command: string, output: string, exitCode: number | null, status = exitCode ? "failed" : "completed") => ({
  type: "tool_call",
  status,
  detail: { type: "shell", command, output, exitCode },
});

describe("parseTestOutput on real runner output", () => {
  it("vitest", () => {
    const run = parseTestOutput(fixture("vitest.txt"));
    expect(run.counts).toMatchObject({ passed: 1, failed: 1, skipped: 1, total: 3 });
    expect(run.durationMs).toBe(268);
    expect(run.failures).toEqual([{ name: "calc.test.ts > calc > subtracts", line: "AssertionError: expected 2 to be 1 // Object.is equality" }]);
  });
  it("jest", () => {
    const run = parseTestOutput(fixture("jest.txt"));
    expect(run.counts).toMatchObject({ passed: 1, failed: 1, total: 2 });
    expect(run.durationMs).toBe(210);
    expect(run.failures).toEqual([{ name: "calc › subtracts", line: "expect(received).toBe(expected) // Object.is equality" }]);
  });
  it("pytest", () => {
    const run = parseTestOutput(fixture("pytest.txt"));
    expect(run.counts).toMatchObject({ passed: 2, failed: 1, total: 3 });
    expect(run.durationMs).toBe(30);
    expect(run.failures).toEqual([{ name: "test_calc.py::test_sub", line: "AssertionError: subtraction is off" }]);
  });
  it("go test without -v", () => {
    const run = parseTestOutput(fixture("go.txt"));
    expect(run.counts).toMatchObject({ passed: null, failed: 1, unit: "tests" });
    expect(run.failures).toEqual([{ name: "TestSub", line: "calc_test.go:4: Sub(3,1) = 3, want 2" }]);
    expect(run.durationMs).toBe(3);
  });
  it("go test -v", () => {
    const run = parseTestOutput(fixture("go-v.txt"));
    expect(run.counts).toMatchObject({ passed: 1, failed: 1, total: 2 });
    expect(run.failures).toEqual([{ name: "TestSub", line: "calc_test.go:4: Sub(3,1) = 3, want 2" }]);
  });
  it("cargo test", () => {
    const run = parseTestOutput(fixture("cargo.txt"));
    expect(run.counts).toMatchObject({ passed: 1, failed: 1, skipped: 0, total: 2 });
    expect(run.durationMs).toBe(80);
    expect(run.failures).toEqual([{ name: "tests::subtracts", line: "assertion `left == right` failed: subtraction is off" }]);
  });
  it("node --test (TAP)", () => {
    const run = parseTestOutput(fixture("node-tap.txt"));
    expect(run.counts).toMatchObject({ passed: 1, failed: 1, total: 2 });
    expect(run.durationMs).toBe(66);
    expect(run.failures).toEqual([{ name: "subtracts", line: "2 == 1" }]);
  });
  it("node --test (spec)", () => {
    const run = parseTestOutput(fixture("node-spec.txt"));
    expect(run.counts).toMatchObject({ passed: 1, failed: 1 });
    expect(run.failures).toEqual([{ name: "subtracts", line: "AssertionError [ERR_ASSERTION]: 2 == 1" }]);
  });
});

describe("parseTestOutput on output an agent cut with tail", () => {
  it("node --test spec output from `npm test 2>&1 | tail -30; cat src/calc.js` (real agent run)", () => {
    const run = parseTestOutput(fixture("node-spec-tail.txt"));
    expect(run.counts).toBeNull();
    expect(run.failures).toEqual([{ name: "subtracts negatives", line: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:" }]);
    const card = testCard(shell("npm test 2>&1 | tail -30; cat src/calc.js", fixture("node-spec-tail.txt"), null, "completed"), patterns);
    expect(card).toMatchObject({ command: "npm test", passed: false });
  });
});

describe("parseTestOutput on passing and partial output", () => {
  it("reads passing summaries", () => {
    expect(parseTestOutput(" Test Files  2 passed (2)\n      Tests  12 passed (12)\n   Duration  1.39s (transform 1ms)").counts).toMatchObject({ passed: 12, failed: null, total: 12 });
    expect(parseTestOutput("============ 5 passed in 0.12s ============").counts).toMatchObject({ passed: 5, total: 5 });
    expect(parseTestOutput("ok  \tgithub.com/x/a\t0.010s\nok  \tgithub.com/x/b\t0.400s").counts).toMatchObject({ passed: 2, unit: "packages" });
    expect(parseTestOutput("  14 passing (2s)\n  1 pending").counts).toMatchObject({ passed: 14, skipped: 1, total: 15 });
  });
  it("reads vitest reporter lines when the failure section was cut by tail", () => {
    const run = parseTestOutput("   × calc > subtracts 7ms\n     → expected 2 to be 1\n      Tests  1 failed | 1 passed (2)");
    expect(run.failures).toEqual([{ name: "calc > subtracts", line: "expected 2 to be 1" }]);
  });
  it("gives nothing for output it can't read", () => {
    expect(parseTestOutput("src/a.ts(3,1): error TS2304: Cannot find name 'x'.")).toEqual({ counts: null, durationMs: null, failures: [], moreFailures: 0 });
    expect(parseTestOutput("")).toMatchObject({ counts: null, failures: [] });
  });
  it("caps the failure list", () => {
    const output = Array.from({ length: 25 }, (_, i) => `FAILED t.py::test_${i} - boom`).join("\n");
    const run = parseTestOutput(output);
    expect(run.failures).toHaveLength(20);
    expect(run.moreFailures).toBe(5);
  });
});

describe("test card", () => {
  it("is a failed card with only the failing tests", () => {
    const card = testCard(shell("cd py && pytest -q 2>&1", fixture("pytest.txt"), 1), patterns);
    expect(card).toMatchObject({ command: "pytest -q", passed: false, exitCode: 1, failures: [{ name: "test_calc.py::test_sub" }] });
    expect(testSummaryText(card!)).toBe("1 failed · 2 passed · 30 ms");
  });
  it("is failed when a pipe hid the exit code but the output shows failures", () => {
    const card = testCard(shell("npx vitest run | tail -20", fixture("vitest.txt"), 0), patterns);
    expect(card?.passed).toBe(false);
  });
  it("is passed on a clean run", () => {
    const card = testCard(shell("npm test", "      Tests  4 passed (4)\n   Duration  900ms", 0), patterns);
    expect(card).toMatchObject({ passed: true, failures: [] });
    expect(testSummaryText(card!)).toBe("4 passed · 900 ms");
  });
  it("keeps Paseo's row for non-test commands, unreadable output and running calls", () => {
    expect(testCard(shell("ls -la", "      Tests  4 passed (4)", 0), patterns)).toBeNull();
    expect(testCard(shell("npx tsc --noEmit", "src/a.ts(1,1): error TS1005", 2), patterns)).toBeNull();
    expect(testCard({ ...shell("npm test", "", null), status: "running" }, patterns)).toBeNull();
  });
  it("keeps the end of very long output", () => {
    const output = `${"x".repeat(40_000)}\n      Tests  1 passed (1)`;
    const card = testCard(shell("npm test", output, 0), patterns)!;
    expect(card.output.length).toBe(32_000);
    expect(card.outputCut).toBe(output.length - 32_000);
    expect(card.output.endsWith("Tests  1 passed (1)")).toBe(true);
  });
});

describe("edit diff", () => {
  it("reads a unified diff", () => {
    const diff = diffFromUnified("--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,2 +10,3 @@\n y\n+z\n");
    expect(diff).toMatchObject({ added: 2, removed: 1, moreLines: 0 });
    expect(diff.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c", "gap:", "ctx:y", "add:z"]);
  });
  it("diffs old and new strings line by line, deletions first, with 2 lines of context", () => {
    const before = ["1", "2", "3", "4", "5", "old", "7", "8", "9", "10"].join("\n");
    const after = ["1", "2", "3", "4", "5", "new", "extra", "7", "8", "9", "10"].join("\n");
    const diff = diffFromStrings(before, after);
    expect(diff).toMatchObject({ added: 2, removed: 1 });
    expect(diff.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["ctx:4", "ctx:5", "del:old", "add:new", "add:extra", "ctx:7", "ctx:8"]);
  });
  it("marks a gap between distant changes", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const after = [...before];
    after[1] = "A";
    after[18] = "B";
    const kinds = diffFromStrings(before.join("\n"), after.join("\n")).lines.map((l) => l.kind);
    expect(kinds.filter((k) => k === "gap")).toHaveLength(1);
  });
  it("counts a written file as all added", () => {
    expect(diffFromContent("a\nb\nc\n")).toMatchObject({ added: 3, removed: 0 });
  });
});

describe("edit card", () => {
  const edit = (detail: Record<string, unknown>, status = "completed") => ({ type: "tool_call", status, detail: { type: "edit", filePath: "/w/src/calc.ts", ...detail } });
  it("builds from old and new strings", () => {
    expect(editCard(edit({ oldString: "a - b", newString: "a + b" }))).toMatchObject({ path: "/w/src/calc.ts", mode: "edit", added: 1, removed: 1 });
  });
  it("prefers the unified diff", () => {
    expect(editCard(edit({ oldString: "x", newString: "y", unifiedDiff: "@@ -1 +1,2 @@\n-x\n+y\n+z" }))).toMatchObject({ added: 2, removed: 1 });
  });
  it("covers whole-file writes", () => {
    expect(editCard({ type: "tool_call", status: "completed", detail: { type: "write", filePath: "/w/n.ts", content: "a\nb" } })).toMatchObject({ mode: "write", added: 2, removed: 0 });
  });
  it("keeps Paseo's row when there is nothing to show or the edit failed", () => {
    expect(editCard(edit({}))).toBeNull();
    expect(editCard(edit({ oldString: "same", newString: "same" }))).toBeNull();
    expect(editCard(edit({ oldString: "a", newString: "b" }, "failed"))).toBeNull();
  });
});

describe("toolCardFor", () => {
  const vitestCall = shell("npx vitest run", fixture("vitest.txt"), 1);
  it("only replaces finished rows", () => {
    expect(toolCardFor(vitestCall, "streaming", config)).toBeUndefined();
    expect(toolCardFor(vitestCall, "complete", config)?.items[0]).toMatchObject({ type: "plugin", kind: "test-card", version: 1 });
  });
  it("follows the on/off settings and the check patterns", () => {
    expect(toolCardFor(vitestCall, "complete", { ...config, testCards: false })).toBeUndefined();
    expect(toolCardFor(vitestCall, "complete", { ...config, checkPatterns: ["pytest"] })).toBeUndefined();
    const editCall = { type: "tool_call", status: "completed", detail: { type: "edit", filePath: "a", oldString: "1", newString: "2" } };
    expect(toolCardFor(editCall, "complete", config)?.items[0]).toMatchObject({ kind: "edit-card" });
    expect(toolCardFor(editCall, "complete", { ...config, editCards: false })).toBeUndefined();
  });
  it("returns JSON-only data", () => {
    const result = toolCardFor(vitestCall, "complete", config)!;
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("durationText", () => {
  it("formats", () => {
    expect(durationText(340)).toBe("340 ms");
    expect(durationText(1234)).toBe("1.2 s");
    expect(durationText(42_000)).toBe("42 s");
    expect(durationText(125_000)).toBe("2 min 5 s");
  });
});

describe("displayPath and keepIndent", () => {
  it("shows paths relative to the agent's folder, like Paseo's rows", () => {
    expect(displayPath("/w/demo/src/calc.js", "/w/demo")).toBe("src/calc.js");
    expect(displayPath("/w/demo/src/calc.js", "/w/demo/")).toBe("src/calc.js");
    expect(displayPath("/w/demo-2/a.js", "/w/demo")).toBe("/w/demo-2/a.js");
    expect(displayPath("C:\\w\\a.ts", "C:\\w")).toBe("a.ts");
    expect(displayPath("/x/a.js", null)).toBe("/x/a.js");
  });
  it("keeps leading spaces and tabs", () => {
    expect(keepIndent("  return a;")).toBe("\u00a0\u00a0return a;");
    expect(keepIndent("\tx  y")).toBe("\u00a0\u00a0x  y");
  });
});
