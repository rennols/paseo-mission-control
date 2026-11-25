/**
 * Read-only git queries for the Review inbox. Touches processes on your machine: runs `git
 * rev-parse`, `git status`, `git merge-base`, `git rev-list`, `git diff` and `git ls-files` in an
 * agent's worktree, with a 10 s timeout. Never a command that writes.
 *
 * "Changes still in the worktree" means uncommitted changes, untracked files, or commits not on
 * the base branch. Only linked git worktrees count (Paseo's worktree workspaces); an agent working
 * in a project's main checkout is not offered for commit and PR.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChangedFile } from "../../shared/queue";

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const DIFF_EXCERPT_LINES = 160;
const DIFF_EXCERPT_CHARS = 12_000;
const MAX_FILES = 200;
const UNTRACKED_COUNT_BYTES = 512 * 1024;

export function runGit(cwd: string, args: string[], timeout = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, "--no-optional-locks", ...args],
      { timeout, maxBuffer: MAX_BUFFER, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || "").trim().split("\n").slice(-2).join(" ");
          reject(new Error(detail || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export interface ReviewState {
  branch: string | null;
  /** Branch the PR targets, without "origin/". */
  baseBranch: string | null;
  files: ChangedFile[];
  linesAdded: number;
  linesRemoved: number;
  uncommitted: boolean;
  commitsAhead: number;
  diffExcerpt: string;
  diffTruncated: boolean;
}

/** True for a linked worktree (git-dir differs from the common dir), false for a main checkout. */
export async function isLinkedWorktree(cwd: string): Promise<boolean> {
  const out = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  const [gitDir, commonDir] = out.trim().split("\n");
  return Boolean(gitDir && commonDir && path.resolve(gitDir) !== path.resolve(commonDir));
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return runGit(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).then(
    () => true,
    () => false,
  );
}

/**
 * The ref to compare against: the given base if it exists (as a local or origin branch), else the
 * remote's default branch, else a local main, master, develop or trunk.
 */
export async function resolveBase(cwd: string, preferred: string | null): Promise<{ ref: string; name: string } | null> {
  const candidates: string[] = [];
  if (preferred) candidates.push(preferred, `origin/${preferred}`);
  const originHead = await runGit(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  if (originHead.trim()) candidates.push(originHead.trim());
  for (const name of ["main", "master", "develop", "trunk"]) candidates.push(`origin/${name}`, name);
  for (const ref of candidates) {
    if (await refExists(cwd, ref)) return { ref, name: ref.replace(/^origin\//, "") };
  }
  return null;
}

/** Splits `git diff --numstat -z` output; renames carry the new path. */
export function parseNumstat(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part) continue;
    const [added, removed, name] = part.split("\t");
    let file = name;
    if (name === "") {
      // Rename: "added\tremoved\t" then old path, new path as separate fields.
      index += 2;
      file = parts[index];
    }
    if (!file) continue;
    files.push({
      path: file,
      added: added && /^\d+$/.test(added) ? Number(added) : null,
      removed: removed && /^\d+$/.test(removed) ? Number(removed) : null,
      untracked: false,
    });
  }
  return files;
}

async function countLines(file: string): Promise<number | null> {
  try {
    const buffer = await readFile(file);
    if (buffer.length > UNTRACKED_COUNT_BYTES || buffer.includes(0)) return null;
    const text = buffer.toString("utf8");
    if (text.length === 0) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return null;
  }
}

/** Null when `cwd` is not a linked git worktree or git fails. */
export async function readReview(cwd: string, preferredBase: string | null): Promise<ReviewState | null> {
  try {
    if (!(await isLinkedWorktree(cwd))) return null;
    const branchOut = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
    const branch = branchOut && branchOut !== "HEAD" ? branchOut : null;
    const base = await resolveBase(cwd, preferredBase);
    const mergeBase = base ? (await runGit(cwd, ["merge-base", base.ref, "HEAD"]).catch(() => "")).trim() : "";
    const compare = mergeBase || "HEAD";
    const commitsAhead = mergeBase ? Number((await runGit(cwd, ["rev-list", "--count", `${mergeBase}..HEAD`])).trim()) || 0 : 0;
    const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const uncommitted = status.length > 0;

    const tracked = parseNumstat(await runGit(cwd, ["diff", compare, "--numstat", "-z", "-M"]));
    const untrackedNames = (await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const untracked: ChangedFile[] = [];
    for (const name of untrackedNames.slice(0, MAX_FILES)) {
      const lines = await countLines(path.join(cwd, name));
      untracked.push({ path: name, added: lines, removed: lines === null ? null : 0, untracked: true });
    }
    const files = [...tracked, ...untracked].slice(0, MAX_FILES);
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const file of [...tracked, ...untracked]) {
      linesAdded += file.added ?? 0;
      linesRemoved += file.removed ?? 0;
    }

    const fullDiff = files.length > 0 ? await runGit(cwd, ["diff", compare, "-M", "--no-color", "--no-ext-diff"]) : "";
    const lines = fullDiff.split("\n");
    let excerpt = lines.slice(0, DIFF_EXCERPT_LINES).join("\n");
    let diffTruncated = lines.length > DIFF_EXCERPT_LINES;
    if (excerpt.length > DIFF_EXCERPT_CHARS) {
      excerpt = excerpt.slice(0, DIFF_EXCERPT_CHARS);
      diffTruncated = true;
    }
    if (untracked.length > 0) {
      excerpt += `${excerpt ? "\n" : ""}New files not yet tracked: ${untracked.map((file) => file.path).slice(0, 20).join(", ")}${untracked.length > 20 ? ", …" : ""}`;
    }

    return {
      branch,
      baseBranch: base?.name ?? null,
      files,
      linesAdded,
      linesRemoved,
      uncommitted,
      commitsAhead,
      diffExcerpt: excerpt,
      diffTruncated,
    };
  } catch {
    return null;
  }
}

export function hasChanges(state: ReviewState): boolean {
  return state.uncommitted || state.commitsAhead > 0 || state.files.length > 0;
}
