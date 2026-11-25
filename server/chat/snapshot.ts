/**
 * Snapshots of an agent's worktree, for the turn summary's file list.
 *
 * Touches files and processes on your machine:
 * - Runs `git rev-parse`, `git add -A` and `git write-tree` against a temporary index file kept in
 *   `$PASEO_HOME/mission-control/snapshots/`, copied from the repo's own index. The repo's index,
 *   HEAD, branches and working files are never changed.
 * - `git add` stores the current file contents as loose objects in the repo's object database
 *   (`.git/objects`), the same way `git stash create` would. Nothing references them, so `git gc`
 *   removes them after its usual grace period.
 * - Runs `git diff --numstat` between two snapshots.
 *
 * Untracked files are included; files your `.gitignore` excludes are not. Runs only after a hook
 * handler has returned (through the adapter's `defer`), never inside one.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MAX_FILES, type SummaryFile } from "../../shared/chat";

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export interface Snapshot {
  /** Top of the git checkout the agent works in. */
  root: string;
  /** Tree id of the whole working tree (tracked and untracked, ignored files left out). */
  tree: string;
  takenAt: number;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, "--no-optional-locks", ...args],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Null when `cwd` is not inside a git checkout or git fails. */
export async function takeSnapshot(cwd: string, scratchDirectory: string): Promise<Snapshot | null> {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  if (!root) return null;
  await mkdir(scratchDirectory, { recursive: true });
  const index = path.join(scratchDirectory, `${randomUUID()}.index`);
  try {
    const realIndex = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());
    // Starting from the real index lets git reuse its cached file stats, so only changed files are hashed.
    await copyFile(realIndex, index).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const env = { GIT_INDEX_FILE: index };
    await git(root, ["add", "-A", "--", "."], env);
    const tree = (await git(root, ["write-tree"], env)).trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? { root, tree, takenAt: Date.now() } : null;
  } catch {
    return null;
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
    await rm(`${index}.lock`, { force: true }).catch(() => undefined);
  }
}

/**
 * Parses `git diff --numstat -z --no-renames` output. With -z each record is
 * `added\tremoved\tpath\0`; binary files show `-` for both counts.
 */
export function parseNumstat(output: string): { path: string; added: number | null; removed: number | null }[] {
  const files: { path: string; added: number | null; removed: number | null }[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record.replace(/^\n/, ""));
    if (!match) continue;
    const [, added, removed, file] = match;
    files.push({
      path: file as string,
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
    });
  }
  return files;
}

/** Parses `git diff --name-status -z --no-renames`: `A\0path\0M\0path\0…`. */
export function parseNameStatus(output: string): Map<string, SummaryFile["status"]> {
  const statuses = new Map<string, SummaryFile["status"]>();
  const parts = output.split("\0");
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const code = parts[index]?.trim();
    const file = parts[index + 1];
    if (!code || file === undefined) continue;
    statuses.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified");
  }
  return statuses;
}

export interface SnapshotDiff {
  files: SummaryFile[];
  moreFiles: number;
  totalAdded: number;
  totalRemoved: number;
}

/** Files that differ between two snapshots of the same checkout, sorted by path. */
export async function diffSnapshots(before: Snapshot, after: Snapshot): Promise<SnapshotDiff> {
  if (before.tree === after.tree) return { files: [], moreFiles: 0, totalAdded: 0, totalRemoved: 0 };
  const range = [before.tree, after.tree];
  const [numstat, nameStatus] = await Promise.all([
    git(after.root, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", ...range]),
    git(after.root, ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", ...range]),
  ]);
  const statuses = parseNameStatus(nameStatus);
  const all = parseNumstat(numstat)
    .map((file) => ({ ...file, status: statuses.get(file.path) ?? ("modified" as const) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const file of all) {
    totalAdded += file.added ?? 0;
    totalRemoved += file.removed ?? 0;
  }
  return { files: all.slice(0, MAX_FILES), moreFiles: Math.max(0, all.length - MAX_FILES), totalAdded, totalRemoved };
}
