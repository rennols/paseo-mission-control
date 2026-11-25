/**
 * Read-only git queries for the collision radar. Touches processes on your machine: it runs
 * `git rev-parse --git-common-dir`, `git diff --name-only`, `git ls-tree` and `git diff -U0` with a
 * 10 s timeout, never a command that writes. They read the tree snapshots the turn summary already
 * stored in the repo's object database (see ../chat/snapshot.ts); no file in a worktree is read.
 *
 * Runs only after a hook handler has returned (through the adapter's `defer`), never inside one.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { parseHunks, type Hunk } from "./model";

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 8 * 1024 * 1024;

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

/**
 * The repository a worktree belongs to: its shared git directory. Linked worktrees of one repo
 * return the same path, so this is how the radar knows two agents work on the same repo.
 */
export async function commonDirOf(root: string): Promise<string | null> {
  try {
    const raw = (await git(root, ["rev-parse", "--git-common-dir"])).trim();
    if (!raw) return null;
    const absolute = path.resolve(root, raw);
    return await realpath(absolute).catch(() => absolute);
  } catch {
    return null;
  }
}

/** Paths that differ between two trees (renames counted as delete plus add). */
export async function changedPaths(root: string, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const output = await git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", from, to]);
  return output.split("\0").filter(Boolean);
}

/** Blob id of each path in a tree; paths missing from the tree are left out. */
export async function blobsIn(root: string, tree: string, paths: string[]): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  if (paths.length === 0) return blobs;
  const output = await git(root, ["ls-tree", "-r", "-z", "--full-tree", tree, "--", ...paths]);
  for (const record of output.split("\0")) {
    // `<mode> <type> <id>\t<path>`
    const match = /^\d+ (\w+) ([0-9a-f]+)\t(.*)$/s.exec(record);
    if (match && match[1] === "blob") blobs.set(match[3] as string, match[2] as string);
  }
  return blobs;
}

/** Changed line ranges between two blobs, in the first blob's line numbers. */
export async function hunksBetween(root: string, from: string, to: string): Promise<Hunk[]> {
  if (from === to) return [];
  const output = await git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", from, to]);
  return parseHunks(output);
}
