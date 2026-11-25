import { describe, expect, it } from "vitest";
import { DEFAULT_WATCHDOG_SETTINGS } from "../shared/settings";
import { EMPTY_COUNTERS, applyTurn, isOverTime, type AgentCounters } from "../server/watchdog/rules";
import { analyseTurn, firstErrorLine, normalise, trailingQuestion } from "../server/watchdog/turn";

const user = (text = "Run the tests") => ({ type: "user_message", text, messageId: "m1" });
const said = (text: string) => ({ type: "assistant_message", text, messageId: "m2" });

/** Claude's failed shell call, as recorded in step 0 (seq 53): status failed, no exitCode, error.content. */
function claudeFailure(command: string, content: string) {
  return {
    type: "tool_call",
    callId: "c1",
    name: "Bash",
    detail: { type: "shell", command },
    status: "failed",
    error: { type: "tool_result", content, is_error: true, tool_use_id: "toolu_1" },
  };
}

const npmTestFailure = (ms: number) =>
  claudeFailure(
    "npm test",
    `Exit code 1\n\n> demo@1.0.0 test\n> node --test\n\nnot ok 1 - adds numbers\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n3 !== 4\n  duration_ms: ${ms}`,
  );

describe("turn analysis", () => {
  it("builds the same signature for the same failure with different numbers and paths", () => {
    const a = analyseTurn([user(), npmTestFailure(12.5), said("The test still fails.")]);
    const b = analyseTurn([user(), npmTestFailure(48.1), said("Still failing.")]);
    expect(a.failures).toHaveLength(1);
    expect(a.failures[0]?.signature).toBe(b.failures[0]?.signature);
    expect(a.failures[0]?.signature).toContain("npm test");
    expect(a.failures[0]?.signature).toContain("not ok <n> - adds numbers");
  });

  it("reads a non-zero exitCode on a completed shell call as a failure (Codex shape)", () => {
    const facts = analyseTurn([
      user(),
      { type: "tool_call", callId: "c", name: "shell", status: "completed", error: null, detail: { type: "shell", command: "go test ./...", output: "--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 3, want 4\nFAIL", exitCode: 1 } },
    ]);
    expect(facts.failures).toHaveLength(1);
    expect(facts.failures[0]?.errorLine).toContain("fail");
  });

  it("counts edits and spots user-started turns", () => {
    const facts = analyseTurn([
      user(),
      { type: "tool_call", callId: "e", name: "Edit", status: "completed", error: null, detail: { type: "edit", filePath: "/w/src/a.ts" } },
      said("Done."),
    ]);
    expect(facts.fileEdits).toBe(1);
    expect(facts.userStarted).toBe(true);
    expect(analyseTurn([said("Worker finished: OK")]).userStarted).toBe(false);
  });

  it("never throws on unknown shapes", () => {
    expect(() => analyseTurn([null, 3, "x", { type: "tool_call", status: "failed", error: { weird: [1, 2] } }, { type: "reasoning" }])).not.toThrow();
  });

  it("finds a trailing question, ignoring code blocks", () => {
    expect(trailingQuestion("I can do either. Do you prefer red or blue?")).toBe("Do you prefer red or blue?");
    expect(trailingQuestion("Done.\n```js\nconst ok = a ? b : c?\n```")).toBeNull();
    expect(trailingQuestion("All tests pass.")).toBeNull();
  });

  it("picks the error line, not the exit code", () => {
    expect(firstErrorLine("Exit code 2\nls: cannot access '/nonexistent-dir-xyz': No such file or directory")).toContain("No such file");
    expect(normalise("FAIL /home/me/src/a.test.ts (2.31 s)")).toBe(normalise("FAIL /tmp/x/src/a.test.ts (1.9 s)"));
  });
});

describe("watchdog rules", () => {
  const settings = DEFAULT_WATCHDOG_SETTINGS; // 3 same-error turns, 5 idle turns, 45 min

  function run(turns: { items: unknown[]; changed?: boolean }[]) {
    let counters: AgentCounters = EMPTY_COUNTERS;
    return turns.map(({ items, changed = false }) => {
      const verdict = applyTurn(counters, analyseTurn(items), changed, settings);
      counters = verdict.counters;
      return verdict;
    });
  }

  it("trips on the third turn in a row with the same error (the looping agent)", () => {
    const verdicts = run([
      { items: [user(), npmTestFailure(10), said("Fails.")] },
      { items: [user("Try again"), npmTestFailure(11), said("Fails.")] },
      { items: [user("Try again"), npmTestFailure(12), said("Fails.")] },
    ]);
    expect(verdicts.map((verdict) => verdict.trips.length)).toEqual([0, 0, 1]);
    expect(verdicts[2]?.trips[0]).toMatchObject({ reason: "same-error", turns: 3 });
    expect(verdicts[1]?.repeated).toHaveLength(1);
  });

  it("resets the streak when a turn passes without that error", () => {
    const verdicts = run([
      { items: [user(), npmTestFailure(10)] },
      { items: [user(), npmTestFailure(10)] },
      { items: [user(), said("Fixed it.")], changed: true },
      { items: [user(), npmTestFailure(10)] },
    ]);
    expect(verdicts.every((verdict) => verdict.trips.length === 0)).toBe(true);
  });

  it("does not count turns Paseo started on its own toward no-changes", () => {
    const quiet = { items: [user("What next?"), said("Nothing yet.")] };
    const woken = { items: [said("Worker finished.")] };
    const verdicts = run([quiet, woken, quiet, woken, quiet, woken, quiet, woken]);
    expect(verdicts.map((verdict) => verdict.counters.turnsWithoutChanges)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(verdicts.some((verdict) => verdict.trips.length > 0)).toBe(false);
    expect(verdicts[1]?.counted).toBe(false);
    const fifth = run([quiet, quiet, quiet, quiet, quiet]);
    expect(fifth[4]?.trips[0]).toMatchObject({ reason: "no-changes", turns: 5 });
  });

  it("flags a run past the time limit plus extensions", () => {
    const start = 0;
    expect(isOverTime(start, 44 * 60_000, settings, 0)).toBe(false);
    expect(isOverTime(start, 46 * 60_000, settings, 0)).toBe(true);
    expect(isOverTime(start, 46 * 60_000, settings, 30)).toBe(false);
  });
});

describe("error lines from real runners", () => {
  it("prefers the runner's failure line over YAML noise (node --test, seen on a real run)", () => {
    const output = "> loop-demo@1.0.0 test\n> node --test\n\nTAP version 13\n# Subtest: adds numbers\nnot ok 1 - adds numbers\n  ---\n  duration_ms: 1.2\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly equal:\n";
    expect(firstErrorLine(output)).toBe("not ok 1 - adds numbers");
  });
  it("handles pytest, go and tsc shapes", () => {
    expect(firstErrorLine("collected 3 items\n\ntest_a.py F\nE       assert 3 == 4\nFAILED test_a.py::test_add")).toBe("E       assert 3 == 4");
    expect(firstErrorLine("--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 3")).toBe("--- FAIL: TestAdd (0.00s)");
    expect(firstErrorLine("src/a.ts:3:7 - error TS2322: Type 'number'")).toContain("error TS2322");
  });
});
