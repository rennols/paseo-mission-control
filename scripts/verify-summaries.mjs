#!/usr/bin/env node
/**
 * Phase gate 2 check: runs real agent turns in a scratch git repo and compares each turn's summary
 * (as Mission Control logged it) with what git says changed in that turn.
 *
 *   node scripts/verify-summaries.mjs [--turns 20] [--provider claude] [--manual]
 *
 * What it touches, so you can decide before running it:
 * - Creates a scratch repo under your temp folder (printed at the start). Nothing else on disk.
 * - Starts one agent there (title "mc-verify") through the `paseo` CLI and sends it up to 20 prompts.
 *   The prompts only edit files in the scratch repo and run `npm test` (Node's built-in test runner).
 * - Approves that one agent's permission requests with `paseo permit allow <agent>`, so the run is
 *   unattended. It never approves any other agent. Pass --manual to approve them yourself instead.
 * - After each turn it runs `git add -A` and `git commit` in the scratch repo, so the next turn
 *   starts from a clean base. Your own repos are never touched.
 * - Reads `paseo plugin logs mission-control` and `$PASEO_HOME/mission-control/state.json`.
 *
 * Output: one line per turn and a report file (path printed at the end) to paste back.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const TURNS = Number(option("turns", "20"));
const PROVIDER = option("provider", "claude");
const MANUAL = args.includes("--manual");
const TURN_TIMEOUT_MS = 10 * 60_000;

const PROMPTS = [
  "Add a function subtract(a, b) to calc.js, add a test for it in calc.test.js, then run npm test.",
  "Create README.md describing each function in calc.js in one line each. Don't run anything.",
  "Move calc.js to src/calc.js, update the import in calc.test.js, then run npm test.",
  "Delete README.md. Don't change anything else.",
  "Without changing any files, explain in two sentences what src/calc.js does.",
  "Using the shell (sed, not your edit tool), change the word 'add' in the first line of src/calc.js's comment or code to keep behaviour the same but rename the parameter a to x everywhere in the add function. Then run npm test.",
  "Add a test to calc.test.js expecting multiply(2, 3) to equal 6, importing multiply from ./src/calc.js, but do not implement multiply yet. Run npm test and report the failure.",
  "Implement multiply in src/calc.js so the tests pass, then run npm test.",
  "Create docs/a.md and docs/b.md, each with one line of text.",
  "Using the shell, run: node -e \"require('fs').mkdirSync('assets',{recursive:true});require('fs').writeFileSync('assets/blob.bin', Buffer.from([0,1,2,3,255,254,0,7]))\"",
  "Don't change any files. End your reply by asking me whether I want a divide function.",
  "Yes. Add divide(a, b) to src/calc.js that throws on b === 0, add two tests, then run npm test.",
  "Commit all current changes with git (git add -A and git commit -m 'wip').",
  "Create a file named 'notes file.txt' (with a space in the name) containing two lines of text.",
  "Add a one-line JSDoc comment above every function in src/calc.js.",
  "Create node_modules/tmp.js containing one line. Don't change anything else.",
  "Run npm test and tell me the result. Don't change any files.",
  "Delete 'notes file.txt'.",
  "Create CHANGELOG.md with a bullet list of the functions in src/calc.js.",
  "Add a \"description\" field to package.json, then run npm test.",
];

function paseo(...cliArgs) {
  return execFileSync("paseo", cliArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function paseoJson(...cliArgs) {
  return JSON.parse(paseo(...cliArgs, "--json"));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Daemon and plugin ----
const status = paseoJson("daemon", "status");
const home = status.home;
console.log(`Daemon ${status.daemonVersion} at ${home}`);
const plugins = paseo("plugin", "ls");
if (!/mission-control\s+running/.test(plugins)) {
  console.error("mission-control is not running on this daemon. Install it first (see the PR's test steps).");
  process.exit(1);
}
const stateFile = path.join(home, "mission-control", "state.json");

// ---- Scratch repo ----
const repo = mkdtempSync(path.join(tmpdir(), "mc-verify-"));
const git = (...gitArgs) => execFileSync("git", ["-C", repo, ...gitArgs], { encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "mc-verify@example.invalid");
git("config", "user.name", "mc-verify");
git("config", "commit.gpgsign", "false");
writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "calc", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
writeFileSync(path.join(repo, "calc.js"), "// add two numbers\nexport function add(a, b) {\n  return a + b;\n}\n");
writeFileSync(path.join(repo, "calc.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "./calc.js";\n\ntest("add", () => assert.equal(add(1, 2), 3));\n');
writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
git("add", "-A");
git("commit", "-qm", "init", "--no-verify");
let base = git("rev-parse", "HEAD").trim();
console.log(`Scratch repo: ${repo}`);

// ---- Helpers ----
function agentRow(agentId) {
  return paseoJson("ls", "-a").find((agent) => agent.id === agentId) ?? null;
}

async function waitForTurn(agentId) {
  const started = Date.now();
  await sleep(3_000);
  for (;;) {
    if (Date.now() - started > TURN_TIMEOUT_MS) throw new Error("turn timed out");
    if (!MANUAL) {
      const pending = paseoJson("permit", "ls").filter((request) => String(request.agentId ?? request.agent ?? "").startsWith(agentId.slice(0, 7)));
      if (pending.length > 0) spawnSync("paseo", ["permit", "allow", agentId], { stdio: "ignore" });
    }
    const row = agentRow(agentId);
    if (row && row.status !== "running") return row.status;
    await sleep(2_000);
  }
}

function summaryLogs(agentId) {
  const lines = paseoJson("plugin", "logs", "mission-control");
  const entries = Array.isArray(lines) ? lines : (lines.entries ?? lines.logs ?? []);
  const out = [];
  for (const entry of entries) {
    const text = typeof entry === "string" ? entry : (entry.message ?? entry.line ?? "");
    const start = text.indexOf("{");
    if (start === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(start));
      if (parsed.feature === "summary" && parsed.message === "Turn summary" && parsed.data?.agentId === agentId) out.push(parsed.data);
    } catch {
      // not one of ours
    }
  }
  return out;
}

async function waitForSummary(agentId, seenTurnIds) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const fresh = summaryLogs(agentId).filter((entry) => !seenTurnIds.has(entry.turnId));
    if (fresh.length > 0) return fresh[fresh.length - 1];
    await sleep(1_000);
  }
  return null;
}

/** What git says changed since the base commit: paths and numstat of the working tree, ignored files left out. */
function gitTruth() {
  git("add", "-A");
  const numstat = git("diff", "--cached", "--numstat", "-z", "--no-renames", base);
  const files = new Map();
  for (const record of numstat.split("\0")) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (match) files.set(match[3], { added: match[1] === "-" ? null : Number(match[1]), removed: match[2] === "-" ? null : Number(match[2]) });
  }
  return files;
}

function storedSummary(agentId, turnId) {
  if (!existsSync(stateFile)) return null;
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  return (state.summaries ?? []).find((entry) => entry.agentId === agentId && entry.turnId === turnId) ?? null;
}

// ---- Run ----
const report = [];
const seen = new Set();
let agentId = null;
let matched = 0;
let compared = 0;

for (let turn = 1; turn <= Math.min(TURNS, PROMPTS.length); turn += 1) {
  const prompt = PROMPTS[turn - 1];
  if (agentId === null) {
    const out = execFileSync(
      "paseo",
      ["run", "--provider", PROVIDER, "--mode", "acceptEdits", "--no-wait", "--quiet", "--title", "mc-verify", prompt],
      { cwd: repo, encoding: "utf8" },
    );
    agentId = out.trim().split(/\s+/).pop();
    console.log(`Agent ${agentId}`);
  } else {
    paseo("send", "--no-wait", agentId, prompt);
  }
  const ended = await waitForTurn(agentId);
  await sleep(1_500);
  const logged = await waitForSummary(agentId, seen);
  // Wait a moment for the state file write (debounced 250 ms) before reading counts.
  await sleep(500);
  const truth = gitTruth();

  let line;
  if (!logged) {
    line = `turn ${turn}: NO SUMMARY LOGGED (agent ${ended}); git: ${[...truth.keys()].join(", ") || "no changes"}`;
  } else {
    seen.add(logged.turnId);
    compared += 1;
    const expected = [...truth.keys()].sort();
    const actual = [...logged.files].sort();
    const sameFiles = JSON.stringify(expected) === JSON.stringify(actual) && logged.moreFiles === 0;
    const stored = logged.card ? storedSummary(agentId, logged.turnId) : null;
    const countIssues = [];
    if (stored) {
      for (const file of stored.files) {
        const want = truth.get(file.path);
        if (want && (want.added !== file.added || want.removed !== file.removed)) {
          countIssues.push(`${file.path} card +${file.added}/-${file.removed} git +${want.added}/-${want.removed}`);
        }
      }
    }
    const ok = sameFiles && countIssues.length === 0;
    if (ok) matched += 1;
    line =
      `turn ${turn}: ${ok ? "OK" : "MISMATCH"} files=${actual.length} card=${logged.card ? "yes" : "no"}` +
      ` checks=[${logged.checks.join("; ")}] question=${logged.question ? "yes" : "no"}` +
      (sameFiles ? "" : ` | card: ${actual.join(", ") || "none"} | git: ${expected.join(", ") || "none"}`) +
      (countIssues.length ? ` | counts: ${countIssues.join("; ")}` : "");
  }
  console.log(line);
  report.push(line);

  // Clean base for the next turn. The agent may have committed; commit whatever is left on top.
  git("add", "-A");
  git("commit", "-qm", `verify turn ${turn}`, "--allow-empty", "--no-verify");
  base = git("rev-parse", "HEAD").trim();
}

const summaryLine = `${matched} of ${compared} summarised turns matched git (${report.length} turns run). Daemon ${status.daemonVersion}, provider ${PROVIDER}.`;
console.log(`\n${summaryLine}`);
const reportDir = path.join(home, "mission-control");
mkdirSync(reportDir, { recursive: true });
const reportFile = path.join(reportDir, `verify-summaries-${Date.now()}.txt`);
writeFileSync(reportFile, `${summaryLine}\nAgent ${agentId}\nRepo ${repo}\n\n${report.join("\n")}\n`);
console.log(`Report: ${reportFile}`);
console.log(`The agent "mc-verify" is still listed; archive it from the app when done. The scratch repo can be deleted: ${repo}`);
process.exit(matched === compared && compared === report.length ? 0 : 1);
