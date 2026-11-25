import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CHECK_PATTERNS } from "../shared/chat";
import { checkKey, checkSegment, collectChecks, covers, matchesCheck, passLine } from "../server/chat/checks";
import { diffSnapshots, parseNameStatus, parseNumstat, takeSnapshot } from "../server/chat/snapshot";
import { deservesCard } from "../server/chat/summary";
import { formatReplies, headline, parsePatterns, parseReplies, replyStarter } from "../client/chat-format";

const shell = (command: string, status: "completed" | "failed", extra: Record<string, unknown> = {}) => ({
  type: "tool_call",
  callId: `c-${command}`,
  name: "Bash",
  detail: { type: "shell", command, ...extra },
  status,
  error: null,
});

describe("matchesCheck", () => {
  it("matches a check at the start of any segment", () => {
    expect(matchesCheck("npm test", DEFAULT_CHECK_PATTERNS)).toBe(true);
    expect(matchesCheck("cd app && npx vitest run src/a.test.ts", DEFAULT_CHECK_PATTERNS)).toBe(true);
    expect(matchesCheck("CI=1 npm test 2>&1 | tail -20", DEFAULT_CHECK_PATTERNS)).toBe(true);
    expect(matchesCheck("go test ./...", DEFAULT_CHECK_PATTERNS)).toBe(true);
  });
  it("shows only the check part of a longer command", () => {
    expect(checkSegment("sed -i 's/a/x/' src/calc.js && cat src/calc.js && npm test 2>&1", DEFAULT_CHECK_PATTERNS)).toBe("npm test");
    expect(checkSegment("cat >> calc.js <<'EOF'\nexport const x = 1;\nEOF\nnpx vitest run a.test.ts", DEFAULT_CHECK_PATTERNS)).toBe("npx vitest run a.test.ts");
  });
  it("ignores commands that only mention a check", () => {
    expect(matchesCheck("cat package.json", DEFAULT_CHECK_PATTERNS)).toBe(false);
    expect(matchesCheck("echo npm test", DEFAULT_CHECK_PATTERNS)).toBe(false);
    expect(matchesCheck("npm testing", ["npm test"])).toBe(false);
    expect(matchesCheck("grep -r jest src", DEFAULT_CHECK_PATTERNS)).toBe(false);
  });
});

describe("collectChecks", () => {
  it("reads pass and fail from the calls the agent made, last run wins", () => {
    const items = [
      { type: "user_message", text: "fix it" },
      shell("ls", "completed"),
      {
        type: "tool_call",
        name: "Bash",
        detail: { type: "shell", command: "npm test" },
        status: "failed",
        error: { type: "tool_result", content: "FAIL src/a.test.ts\nAssertionError: expected 1 to be 2", is_error: true },
      },
      shell("npx tsc --noEmit", "completed", { output: "" }),
      shell("npm test", "completed", { output: " Test Files  3 passed (3)\n      Tests  12 passed (12)\n" }),
    ];
    const checks = collectChecks(items, DEFAULT_CHECK_PATTERNS);
    expect(checks).toEqual([
      { command: "npx tsc --noEmit", passed: true, line: null },
      { command: "npm test", passed: true, line: "Tests 12 passed (12)" },
    ]);
  });
  it("a later pass of the same check replaces an earlier fail, however the agent wrote it", () => {
    const failed = (command: string) => shell(command, "completed", { exitCode: 1, output: "not ok 1 - add\n# fail 1" });
    const passed = (command: string) => shell(command, "completed", { exitCode: 0, output: "# pass 2\n# fail 0" });
    const runs: Array<[string, string]> = [
      ["npm test", "npm test 2>&1 | tail -20"],
      ["npm test > /tmp/out.txt 2>&1; cat /tmp/out.txt", "npm test"],
      ["npm run test", "npm test"],
      ["npm test", "npm test -- --reporter=dot"],
      ["npx vitest run --reporter verbose", "npx vitest run"],
      ["npm test -- test/a.test.js", "npm test"],
      ["pytest tests/test_a.py::test_add", "pytest"],
    ];
    for (const [first, second] of runs) {
      const checks = collectChecks([failed(first), passed(second)], DEFAULT_CHECK_PATTERNS);
      expect(checks, `${first} then ${second}`).toHaveLength(1);
      expect(checks[0]?.passed, `${first} then ${second}`).toBe(true);
    }
  });
  it("a later fail replaces an earlier pass, and the turn ends Failed", () => {
    const checks = collectChecks(
      [shell("npm test", "completed", { output: "# pass 2\n# fail 0" }), shell("npm test 2>&1 | tail", "completed", { output: "# fail 1" })],
      DEFAULT_CHECK_PATTERNS,
    );
    expect(checks).toEqual([{ command: "npm test", passed: false, line: "# fail 1" }]);
  });
  it("a narrower or different run doesn't hide a failure", () => {
    const fail = shell("npm test", "completed", { exitCode: 1, output: "# fail 1" });
    const narrowPass = shell("npm test -- test/a.test.js", "completed", { output: "# pass 1\n# fail 0" });
    expect(collectChecks([fail, narrowPass], DEFAULT_CHECK_PATTERNS).map((check) => [check.command, check.passed])).toEqual([
      ["npm test", false],
      ["npm test -- test/a.test.js", true],
    ]);
    const lint = shell("npm run lint", "completed", { output: "" });
    expect(collectChecks([fail, lint], DEFAULT_CHECK_PATTERNS).map((check) => check.passed)).toEqual([false, true]);
  });
  it("tells reruns of one check apart from other checks", () => {
    expect(checkKey("npm test 2>&1 > out.txt")).toBe("npm test");
    expect(checkKey("npm run test -- --reporter=dot")).toBe("npm test");
    expect(checkKey("npx vitest run --reporter verbose a.test.ts")).toBe("npx vitest run a.test.ts");
    expect(covers("npm test", "npm test -- test/a.test.js")).toBe(true);
    expect(covers("npm test -- test/a.test.js", "npm test")).toBe(false);
    expect(covers("tsc", "tsc -p tsconfig.build.json")).toBe(false);
    expect(covers("go test", "go test ./pkg")).toBe(false);
    expect(covers("go test ./...", "go test ./... -run TestAdd")).toBe(false);
    expect(covers("npm test", "npm run lint")).toBe(false);
  });
  it("treats a non-zero exit code as failed", () => {
    const checks = collectChecks([shell("pytest", "completed", { exitCode: 1, output: "E   assert 1 == 2\n1 failed" })], DEFAULT_CHECK_PATTERNS);
    expect(checks[0]).toMatchObject({ passed: false, line: "E assert 1 == 2" });
  });
  it("reads a failure from output that a pipe made exit 0", () => {
    const tap = "not ok 3 - multiply\n# tests 3\n# pass 2\n# fail 1";
    expect(collectChecks([shell("npm test 2>&1 | tail -9", "completed", { output: tap })], DEFAULT_CHECK_PATTERNS)[0]).toEqual({
      command: "npm test",
      passed: false,
      line: "# fail 1",
    });
    expect(collectChecks([shell("npm test | tail; echo \"exit: ${PIPESTATUS[0]}\"", "completed", { output: "...\nexit: 1" })], DEFAULT_CHECK_PATTERNS)[0]?.passed).toBe(false);
    expect(collectChecks([shell("npm test", "completed", { output: "# pass 3\n# fail 0\nexit: 0" })], DEFAULT_CHECK_PATTERNS)[0]?.passed).toBe(true);
  });
  it("skips running calls and other tools", () => {
    expect(collectChecks([shell("npm test", "completed"), { type: "tool_call", name: "Read", status: "completed", detail: { type: "read" } }].slice(1), DEFAULT_CHECK_PATTERNS)).toEqual([]);
    expect(collectChecks([{ ...shell("npm test", "completed"), status: "running" }], DEFAULT_CHECK_PATTERNS)).toEqual([]);
  });
  it("finds a count line in passing output", () => {
    expect(passLine("ok  \tgithub.com/x/y\t0.01s")).toBe("ok github.com/x/y 0.01s");
    expect(passLine("TAP version 13\nok 1 - add\n1..1\n# tests 1\n# pass 1\n# fail 0\n# duration_ms 40")).toBe("# pass 1");
    expect(passLine("nothing here")).toBeNull();
  });
});

describe("git output parsing", () => {
  it("parses -z numstat, including binary files and odd names", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\0-\t-\timg.png\0" + "0\t4\tdir/with space.md\0")).toEqual([
      { path: "src/a.ts", added: 3, removed: 1 },
      { path: "img.png", added: null, removed: null },
      { path: "dir/with space.md", added: 0, removed: 4 },
    ]);
  });
  it("parses -z name-status", () => {
    expect([...parseNameStatus("A\0new.ts\0M\0old.ts\0D\0gone.ts\0").entries()]).toEqual([
      ["new.ts", "added"],
      ["old.ts", "modified"],
      ["gone.ts", "deleted"],
    ]);
  });
});

describe("snapshots on a real git repo", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mc-snap-"));
  const repo = path.join(root, "repo");
  const scratch = path.join(root, "scratch");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("lists exactly the files changed between two snapshots, untracked included, ignored left out", async () => {
    mkdirSync(repo);
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(path.join(repo, "b.txt"), "keep\n");
    writeFileSync(path.join(repo, "dirty.txt"), "committed\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    // Uncommitted before the turn: must not show up as a change made in the turn.
    writeFileSync(path.join(repo, "dirty.txt"), "edited before the turn\n");
    const indexBefore = git("diff", "--cached", "--name-only");

    const before = await takeSnapshot(path.join(repo), scratch);
    expect(before).not.toBeNull();

    writeFileSync(path.join(repo, "a.txt"), "one\nTWO\nthree\n");
    unlinkSync(path.join(repo, "b.txt"));
    writeFileSync(path.join(repo, "new.ts"), "export {};\n");
    mkdirSync(path.join(repo, "node_modules"));
    writeFileSync(path.join(repo, "node_modules", "x.js"), "ignored\n");
    git("add", "a.txt"); // the agent staged one file
    git("commit", "-qm", "agent commit"); // and committed it

    const after = await takeSnapshot(path.join(repo), scratch);
    const diff = await diffSnapshots(before!, after!);
    expect(diff.files).toEqual([
      { path: "a.txt", added: 2, removed: 1, status: "modified" },
      { path: "b.txt", added: 0, removed: 1, status: "deleted" },
      { path: "new.ts", added: 1, removed: 0, status: "added" },
    ]);
    expect(diff.totalAdded).toBe(3);
    expect(diff.totalRemoved).toBe(2);
    // The repo's own index and working files were not touched by the snapshots.
    expect(git("diff", "--cached", "--name-only")).toBe(indexBefore);
    expect(git("status", "--porcelain")).toContain("?? new.ts");
  });

  it("returns null outside a git checkout", async () => {
    expect(await takeSnapshot(root, scratch)).toBeNull();
  });
});

describe("card helpers", () => {
  const base = {
    agentId: "a",
    turnId: "t",
    startedAt: 0,
    endedAt: 125_000,
    outcome: "completed" as const,
    filesTracked: true,
    files: [{ path: "a.ts", added: 3, removed: 1, status: "modified" as const }],
    moreFiles: 0,
    totalAdded: 3,
    totalRemoved: 1,
    checks: [],
    question: null,
    trees: null,
  };
  it("writes the header line", () => {
    expect(headline(base)).toBe("2m 5s · 1 file changed · +3 −1");
    expect(headline({ ...base, outcome: "failed", files: [], totalAdded: 0, totalRemoved: 0 })).toBe("2m 5s · 0 files changed · Turn failed");
  });
  it("gives a card only to turns with changes or checks", () => {
    expect(deservesCard(base)).toBe(true);
    expect(deservesCard({ ...base, files: [] })).toBe(false);
    expect(deservesCard({ ...base, files: [], checks: [{ command: "npm test", passed: true, line: null }] })).toBe(true);
  });
  it("quotes the question as a reply starter", () => {
    expect(replyStarter("Red\n or blue?")).toBe("> Red or blue?\n\n");
  });
});

describe("quick reply settings text", () => {
  it("round-trips replies", () => {
    const { replies, error } = parseReplies("Continue = Continue.\nCommit\n\n");
    expect(error).toBeNull();
    expect(replies).toEqual([
      { label: "Continue", text: "Continue." },
      { label: "Commit", text: "Commit" },
    ]);
    expect(formatReplies(replies)).toBe("Continue = Continue.\nCommit");
  });
  it("rejects too many or empty labels", () => {
    expect(parseReplies(" = text").error).toMatch(/Line 1/);
    expect(parseReplies(Array.from({ length: 9 }, (_, i) => `r${i}`).join("\n")).error).toMatch(/At most 8/);
  });
  it("splits patterns on commas and lines", () => {
    expect(parsePatterns("npm test, pytest\ngo test")).toEqual(["npm test", "pytest", "go test"]);
  });
});
