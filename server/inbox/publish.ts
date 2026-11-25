/**
 * Commit and open PR, for one Review inbox item. Runs only from a click (the `inbox.pr.open` RPC).
 *
 * Touches files, processes and the network on your machine, in the agent's worktree only:
 * 1. `git add -A` and `git commit -m <title>` when there are uncommitted changes (runs the repo's
 *    own git hooks, as a commit you make would);
 * 2. `git push -u origin <branch>` (network: your git remote);
 * 3. `gh pr create --base <base> --head <branch> --title <title> --body <body>` (network: GitHub,
 *    with the `gh` login Paseo already relies on). If a PR for the branch exists, `gh pr view`
 *    returns its link instead.
 * No credentials are read or stored by the plugin; git and gh use their own.
 */
import { execFile } from "node:child_process";
import { runGit } from "./review-git";

const PUSH_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 60_000;

export interface PublishInput {
  cwd: string;
  title: string;
  body: string;
  baseBranch: string | null;
}

export interface PublishResult {
  ok: boolean;
  message: string;
  prUrl: string | null;
  /** The step that ran last: what the user sees on failure. */
  step: "commit" | "push" | "pr" | "done";
}

function gh(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") reject(new Error("The gh command is not installed on this host"));
          else reject(new Error(String(stderr || "").trim().split("\n").slice(-2).join(" ") || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export function findUrl(text: string): string | null {
  return text.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
}

export async function commitPushAndOpenPr(input: PublishInput): Promise<PublishResult> {
  const { cwd, title, body } = input;
  const branch = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  if (!branch || branch === "HEAD") return { ok: false, message: "The worktree is not on a branch.", prUrl: null, step: "commit" };
  if (input.baseBranch && branch === input.baseBranch) {
    return { ok: false, message: `The worktree is on ${branch}, the base branch itself.`, prUrl: null, step: "commit" };
  }

  try {
    const status = await runGit(cwd, ["status", "--porcelain=v1"]);
    if (status.trim()) {
      await runGit(cwd, ["add", "-A"]);
      await runGit(cwd, ["commit", "-m", title], PUSH_TIMEOUT_MS);
    }
  } catch (error) {
    return { ok: false, message: `Commit failed: ${error instanceof Error ? error.message : String(error)}`, prUrl: null, step: "commit" };
  }

  try {
    await runGit(cwd, ["push", "-u", "origin", branch], PUSH_TIMEOUT_MS);
  } catch (error) {
    return { ok: false, message: `Committed, but push failed: ${error instanceof Error ? error.message : String(error)}`, prUrl: null, step: "push" };
  }

  try {
    const args = ["pr", "create", "--head", branch, "--title", title, "--body", body];
    if (input.baseBranch) args.push("--base", input.baseBranch);
    const out = await gh(cwd, args);
    const url = findUrl(out);
    return { ok: true, message: url ? "PR opened." : "PR opened (gh printed no link).", prUrl: url, step: "done" };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(text)) {
      const existing = await gh(cwd, ["pr", "view", branch, "--json", "url", "--jq", ".url"]).catch(() => "");
      const url = findUrl(existing) ?? findUrl(text);
      return { ok: true, message: "Pushed. A PR for this branch already existed.", prUrl: url, step: "done" };
    }
    return { ok: false, message: `Pushed, but gh pr create failed: ${text}`, prUrl: null, step: "pr" };
  }
}
