import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { finalMessage } from "../server/inbox/inbox";
import { findUrl } from "../server/inbox/publish";
import { hasChanges, parseNumstat, readReview } from "../server/inbox/review-git";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

function repoWithWorktree(): { main: string; worktree: string } {
  const root = mkdtempSync(path.join(tmpdir(), "mc-inbox-"));
  const main = path.join(root, "main");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  writeFileSync(path.join(main, "a.txt"), "one\ntwo\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  const worktree = path.join(root, "wt");
  git(main, "worktree", "add", "-q", "-b", "feature", worktree, "main");
  return { main, worktree };
}

describe("review git", () => {
  it("ignores a main checkout", async () => {
    const { main } = repoWithWorktree();
    writeFileSync(path.join(main, "a.txt"), "changed\n");
    expect(await readReview(main, null)).toBeNull();
  });

  it("sees nothing to review in a fresh worktree", async () => {
    const { worktree } = repoWithWorktree();
    const review = await readReview(worktree, null);
    expect(review).not.toBeNull();
    expect(hasChanges(review!)).toBe(false);
    expect(review!.branch).toBe("feature");
    expect(review!.baseBranch).toBe("main");
  });

  it("counts uncommitted edits, new files and commits ahead of the base", async () => {
    const { worktree } = repoWithWorktree();
    writeFileSync(path.join(worktree, "b.txt"), "x\ny\nz\n");
    git(worktree, "add", "b.txt");
    git(worktree, "commit", "-qm", "add b");
    writeFileSync(path.join(worktree, "a.txt"), "one\nTWO\nthree\n");
    writeFileSync(path.join(worktree, "new.txt"), "hello\n");
    const review = await readReview(worktree, "main");
    expect(review).not.toBeNull();
    expect(hasChanges(review!)).toBe(true);
    expect(review!.commitsAhead).toBe(1);
    expect(review!.uncommitted).toBe(true);
    const byPath = Object.fromEntries(review!.files.map((file) => [file.path, file]));
    expect(byPath["a.txt"]).toMatchObject({ added: 2, removed: 1, untracked: false });
    expect(byPath["b.txt"]).toMatchObject({ added: 3, removed: 0 });
    expect(byPath["new.txt"]).toMatchObject({ added: 1, untracked: true });
    expect(review!.linesAdded).toBe(6);
    expect(review!.diffExcerpt).toContain("+TWO");
    expect(review!.diffExcerpt).toContain("new.txt");
  });
});

describe("parsing", () => {
  it("reads numstat with renames and binary files", () => {
    const out = ["3\t1\tsrc/a.ts", "-\t-\timg.png", "0\t0\t", "old/name.ts", "new/name.ts", ""].join("\0");
    expect(parseNumstat(out)).toEqual([
      { path: "src/a.ts", added: 3, removed: 1, untracked: false },
      { path: "img.png", added: null, removed: null, untracked: false },
      { path: "new/name.ts", added: 0, removed: 0, untracked: false },
    ]);
  });

  it("takes the last message run after the last tool call", () => {
    const items = [
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "Looking." },
      { type: "tool_call", name: "Edit" },
      { type: "assistant_message", text: "Done: " },
      { type: "assistant_message", text: "fixed the bug." },
    ];
    expect(finalMessage(items)).toBe("Done: fixed the bug.");
    expect(finalMessage([{ type: "tool_call" }])).toBeNull();
  });

  it("finds the PR link in gh output", () => {
    expect(findUrl("Creating pull request\nhttps://github.com/o/r/pull/12\n")).toBe("https://github.com/o/r/pull/12");
    expect(findUrl("nothing")).toBeNull();
  });
});
