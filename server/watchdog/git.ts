/**
 * Read-only git queries on an agent's working directory. Touches processes on your machine: it
 * runs `git rev-parse`, `git status --porcelain` and `git diff --numstat` with a 5 s timeout, never
 * a command that writes. Used to tell whether a turn changed files (shell commands like `sed -i`
 * don't show up as edit tool calls) and for the lines added and removed on each Live row.
 *
 * Runs only after a hook handler has returned (through the adapter's `defer`), never inside one.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const TIMEOUT_MS = 5_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export interface WorktreeState {
  /** Changes whenever HEAD, the index, tracked files or untracked file names change. */
  fingerprint: string;
  /** Lines added and removed against HEAD, including staged changes. Untracked files not counted. */
  linesAdded: number;
  linesRemoved: number;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, "--no-optional-locks", ...args],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export function sumNumstat(numstat: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of numstat.split("\n")) {
    const [a, r] = line.split("\t");
    // Binary files show "-"; they count as changed (fingerprint) but add no lines.
    if (a && /^\d+$/.test(a)) added += Number(a);
    if (r && /^\d+$/.test(r)) removed += Number(r);
  }
  return { added, removed };
}

/** Null when `cwd` is not a git checkout or git is unavailable. */
export async function readWorktree(cwd: string): Promise<WorktreeState | null> {
  try {
    const head = (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
    const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
    const numstat = head ? await git(cwd, ["diff", "HEAD", "--numstat"]) : "";
    const { added, removed } = sumNumstat(numstat);
    const fingerprint = createHash("sha1").update(head).update("\0").update(status).update("\0").update(numstat).digest("hex");
    return { fingerprint, linesAdded: added, linesRemoved: removed };
  } catch {
    return null;
  }
}
