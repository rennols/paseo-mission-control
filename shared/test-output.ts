/**
 * Reads a test runner's output for the test card: counts, duration, and the failing tests with
 * their first error line. Pure text parsing of output the agent already got; nothing here runs a
 * command. Runs in the app (timeline transformers are client contributions), so it stays small
 * and synchronous.
 *
 * Runners read: vitest, jest, pytest, go test (with and without -v), cargo test, node:test (TAP
 * and spec reporters) and mocha's counts. Anything else returns no counts and no failures, and the
 * caller keeps Paseo's own row.
 */

export interface TestCounts {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  total: number | null;
  /** "tests" for every runner except `go test` without -v, which only reports packages. */
  unit: "tests" | "packages";
}

export interface TestFailure {
  name: string;
  /** The first error line the runner printed for it, if one could be found. */
  line: string | null;
}

export interface ParsedTestRun {
  counts: TestCounts | null;
  durationMs: number | null;
  failures: TestFailure[];
  /** Failing tests found beyond MAX_FAILURES. */
  moreFailures: number;
}

export const MAX_FAILURES = 20;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function toMs(value: string, unit: string): number | null {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return null;
  switch (unit.toLowerCase()) {
    case "ms":
      return Math.round(n);
    case "s":
    case "sec":
    case "secs":
      return Math.round(n * 1000);
    case "m":
    case "min":
      return Math.round(n * 60_000);
    default:
      return null;
  }
}

function emptyCounts(unit: TestCounts["unit"] = "tests"): TestCounts {
  return { passed: null, failed: null, skipped: null, total: null, unit };
}

function add(current: number | null, value: number): number {
  return (current ?? 0) + value;
}

/** "1 failed | 2 passed | 1 skipped" or "1 failed, 2 passed, 3 total". */
function countParts(text: string, counts: TestCounts): void {
  for (const match of text.matchAll(/(\d+)\s+([a-z]+)/gi)) {
    const n = Number(match[1]);
    const word = (match[2] as string).toLowerCase();
    if (word === "passed" || word === "passing" || word === "pass") counts.passed = add(counts.passed, n);
    else if (/^(failed|failing|fail|errors?|cancelled)$/.test(word)) counts.failed = add(counts.failed, n);
    else if (/^(skipped|pending|todo|ignored|xfailed|xpassed|deselected)$/.test(word)) counts.skipped = add(counts.skipped, n);
    else if (word === "total" || word === "tests") counts.total = n;
  }
}

function finish(counts: TestCounts): TestCounts | null {
  if (counts.passed === null && counts.failed === null && counts.total === null) return null;
  if (counts.total === null) counts.total = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0);
  return counts;
}

/** The first line in `lines[from..to)` that reads like an error, else the first non-empty one. */
function errorNear(lines: readonly string[], from: number, to: number, skip?: RegExp): string | null {
  let fallback: string | null = null;
  for (let index = Math.max(0, from); index < Math.min(lines.length, to); index += 1) {
    const line = (lines[index] as string).trim();
    if (!line || /^[⎯─=\-_]{3,}/.test(line) || (skip && skip.test(line))) continue;
    if (/(error|expected|assert|panicked|exception|fail|want|got|received|!=|==)/i.test(line)) return clip(line, 200);
    fallback ??= clip(line, 200);
  }
  return fallback;
}

interface Runner {
  counts(lines: readonly string[]): TestCounts | null;
  duration(lines: readonly string[]): number | null;
  failures(lines: readonly string[]): TestFailure[];
}

const vitest: Runner = {
  counts(lines) {
    const line = lines.find((candidate) => /^\s*Tests\s+\d+\s+\w+.*\(\d+\)\s*$/.test(candidate));
    if (!line) return null;
    const counts = emptyCounts();
    const [, parts, total] = /^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/.exec(line) ?? [];
    countParts(parts ?? "", counts);
    counts.total = Number(total);
    return finish(counts);
  },
  duration(lines) {
    for (const line of lines) {
      const match = /^\s*Duration\s+([\d.]+)\s*(ms|s|m)\b/.exec(line);
      if (match) return toMs(match[1] as string, match[2] as string);
    }
    return null;
  },
  failures(lines) {
    const found: TestFailure[] = [];
    for (const [index, line] of lines.entries()) {
      const match = /^\s*FAIL\s+(.+)$/.exec(line);
      if (!match || !/\s>\s|\[/.test(match[1] as string)) continue;
      found.push({ name: clip(match[1] as string, 200), line: errorNear(lines, index + 1, index + 12, /^❯ /) });
    }
    if (found.length > 0) return found;
    // Reporter lines when the failure section was cut off (e.g. piped through `tail`).
    for (const [index, line] of lines.entries()) {
      const match = /^\s*[×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*ms)?\s*$/.exec(line);
      if (!match) continue;
      const next = /^\s*→\s*(.+)$/.exec(lines[index + 1] ?? "");
      found.push({ name: clip(match[1] as string, 200), line: next ? clip(next[1] as string, 200) : null });
    }
    return found;
  },
};

const jest: Runner = {
  counts(lines) {
    const line = lines.find((candidate) => /^Tests:\s+\d+/.test(candidate));
    if (!line) return null;
    const counts = emptyCounts();
    countParts(line.replace(/^Tests:\s+/, ""), counts);
    return finish(counts);
  },
  duration(lines) {
    for (const line of lines) {
      const match = /^Time:\s+([\d.]+)\s*(ms|s|m)\b/.exec(line);
      if (match) return toMs(match[1] as string, match[2] as string);
    }
    return null;
  },
  failures(lines) {
    const found: TestFailure[] = [];
    for (const [index, line] of lines.entries()) {
      const match = /^\s*●\s+(.+)$/.exec(line);
      if (!match || /^Console\b/.test(match[1] as string)) continue;
      found.push({ name: clip(match[1] as string, 200), line: errorNear(lines, index + 1, index + 10) });
    }
    if (found.length > 0) return found;
    for (const line of lines) {
      const match = /^\s*✕\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/.exec(line);
      if (match) found.push({ name: clip(match[1] as string, 200), line: null });
    }
    return found;
  },
};

const PYTEST_SUMMARY = /^=+\s*(.*?\d+\s+(?:passed|failed|errors?|skipped|xfailed|xpassed|deselected).*?)\s+in\s+([\d.]+)s\b.*=+\s*$/;

const pytest: Runner = {
  counts(lines) {
    const line = lines.find((candidate) => PYTEST_SUMMARY.test(candidate));
    if (!line) return null;
    const counts = emptyCounts();
    countParts((PYTEST_SUMMARY.exec(line) ?? [])[1] ?? "", counts);
    return finish(counts);
  },
  duration(lines) {
    for (const line of lines) {
      const match = PYTEST_SUMMARY.exec(line);
      if (match) return toMs(match[2] as string, "s");
    }
    return null;
  },
  failures(lines) {
    const found: TestFailure[] = [];
    for (const line of lines) {
      const match = /^(?:FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.+))?$/.exec(line);
      if (match) found.push({ name: clip(match[1] as string, 200), line: match[2] ? clip(match[2], 200) : null });
    }
    return found;
  },
};

const cargo: Runner = {
  counts(lines) {
    let counts: TestCounts | null = null;
    for (const line of lines) {
      const match = /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(line);
      if (!match) continue;
      counts ??= emptyCounts();
      counts.passed = add(counts.passed, Number(match[1]));
      counts.failed = add(counts.failed, Number(match[2]));
      counts.skipped = add(counts.skipped, Number(match[3]));
    }
    return counts ? finish(counts) : null;
  },
  duration(lines) {
    let total: number | null = null;
    for (const line of lines) {
      const match = /^test result: .*finished in ([\d.]+)s/.exec(line);
      if (match) total = add(total, toMs(match[1] as string, "s") ?? 0);
    }
    return total;
  },
  failures(lines) {
    const found: TestFailure[] = [];
    for (const line of lines) {
      const match = /^test (\S+) \.\.\. FAILED$/.exec(line);
      if (!match) continue;
      const name = match[1] as string;
      const header = lines.findIndex((candidate) => candidate.trim() === `---- ${name} stdout ----`);
      let error: string | null = null;
      if (header >= 0) {
        const panic = lines.findIndex((candidate, index) => index > header && /panicked at/.test(candidate));
        error = panic >= 0 ? errorNear(lines, panic + 1, panic + 3) ?? clip(lines[panic] as string, 200) : errorNear(lines, header + 1, header + 8);
      }
      found.push({ name, line: error });
    }
    return found;
  },
};

const tap: Runner = {
  counts(lines) {
    const counts = emptyCounts();
    let seen = false;
    for (const line of lines) {
      const match = /^[#ℹ]\s*(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      seen = true;
      const n = Number(match[2]);
      if (match[1] === "tests") counts.total = n;
      else if (match[1] === "pass") counts.passed = n;
      else if (match[1] === "fail" || match[1] === "cancelled") counts.failed = add(counts.failed, n);
      else counts.skipped = add(counts.skipped, n);
    }
    return seen ? finish(counts) : null;
  },
  duration(lines) {
    let found: number | null = null;
    for (const line of lines) {
      const match = /^[#ℹ]\s*duration_ms\s+([\d.]+)\s*$/.exec(line);
      if (match) found = toMs(match[1] as string, "ms");
    }
    return found;
  },
  failures(lines) {
    const found: TestFailure[] = [];
    // node --test spec reporter: a "failing tests:" section with the error under each name.
    const section = lines.findIndex((line) => /^✖ failing tests:/.test(line));
    if (section >= 0) {
      for (let index = section + 1; index < lines.length; index += 1) {
        const match = /^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(lines[index] as string);
        if (match) found.push({ name: clip(match[1] as string, 200), line: errorNear(lines, index + 1, index + 3) });
      }
      return found;
    }
    // Spec reporter output cut by `tail`: the section header is gone, the "✖ name (1ms)" lines are not.
    for (const [index, line] of lines.entries()) {
      const match = /^\s*✖\s+(.+?)\s+\([\d.]+m?s\)\s*$/.exec(line);
      if (!match) continue;
      const next = lines[index + 1] ?? "";
      const detail = /^\s+\S/.test(next) && !/^\s*[✔✖﹣]/.test(next);
      found.push({ name: clip(match[1] as string, 200), line: detail ? errorNear(lines, index + 1, index + 3) : null });
    }
    if (found.length > 0) return found;
    for (const [index, line] of lines.entries()) {
      const match = /^\s*not ok \d+\s*-?\s*(.+?)(?:\s+#.*)?$/.exec(line);
      if (!match) continue;
      let error: string | null = null;
      for (let next = index + 1; next < Math.min(lines.length, index + 30); next += 1) {
        const text = lines[next] as string;
        if (/^\s*\.\.\.\s*$/.test(text)) break;
        const yaml = /^\s*error:\s*(.+)$/.exec(text);
        if (yaml) {
          error = clip((yaml[1] as string).replace(/^(['"|>-]+)|(['"])$/g, ""), 200);
          break;
        }
      }
      found.push({ name: clip(match[1] as string, 200), line: error });
    }
    return found;
  },
};

const mocha: Runner = {
  counts(lines) {
    const counts = emptyCounts();
    let seen = false;
    for (const line of lines) {
      const match = /^\s*(\d+)\s+(passing|failing|pending)\b/.exec(line);
      if (!match) continue;
      seen = true;
      countParts(`${match[1]} ${match[2]}`, counts);
    }
    return seen ? finish(counts) : null;
  },
  duration(lines) {
    for (const line of lines) {
      const match = /^\s*\d+\s+passing\s+\(([\d.]+)(ms|s|m)\)/.exec(line);
      if (match) return toMs(match[1] as string, match[2] as string);
    }
    return null;
  },
  failures() {
    return [];
  },
};

const GO_PACKAGE = /^(ok|FAIL)\s+(\S+)\s+([\d.]+)s\b/;

const goTest: Runner = {
  counts(lines) {
    const counts = emptyCounts();
    let tests = false;
    for (const line of lines) {
      const match = /^--- (PASS|FAIL|SKIP): /.exec(line);
      if (!match) continue;
      tests = true;
      if (match[1] === "PASS") counts.passed = add(counts.passed, 1);
      else if (match[1] === "FAIL") counts.failed = add(counts.failed, 1);
      else counts.skipped = add(counts.skipped, 1);
    }
    if (tests) {
      counts.passed ??= 0;
      counts.failed ??= 0;
      // Without -v Go prints only failing tests, so a pass count would be wrong.
      if (!lines.some((line) => /^=== RUN /.test(line))) counts.passed = null;
      return finish(counts);
    }
    const packages = emptyCounts("packages");
    for (const line of lines) {
      const match = GO_PACKAGE.exec(line);
      if (!match) continue;
      if (match[1] === "ok") packages.passed = add(packages.passed, 1);
      else packages.failed = add(packages.failed, 1);
    }
    return finish(packages);
  },
  duration(lines) {
    // Packages run in parallel, so the slowest one is the closest to wall time.
    let longest: number | null = null;
    for (const line of lines) {
      const match = GO_PACKAGE.exec(line);
      if (match) longest = Math.max(longest ?? 0, toMs(match[3] as string, "s") ?? 0);
    }
    return longest;
  },
  failures(lines) {
    const found: TestFailure[] = [];
    for (const [index, line] of lines.entries()) {
      const match = /^(\s*)--- FAIL: (\S+)/.exec(line);
      if (!match) continue;
      const indent = (match[1] as string).length;
      const name = match[2] as string;
      let error: string | null = null;
      // Without -v the log lines follow the FAIL line, indented further.
      for (let next = index + 1; next < Math.min(lines.length, index + 8); next += 1) {
        const text = lines[next] as string;
        const own = /^(\s*)/.exec(text)?.[1]?.length ?? 0;
        if (own <= indent || /^\s*--- /.test(text)) break;
        error = clip(text, 200);
        break;
      }
      // With -v they come between "=== RUN   Name" and the FAIL line.
      if (!error) {
        const run = lines.findLastIndex((text, at) => at < index && text.trim() === `=== RUN   ${name}`);
        for (let next = run + 1; run >= 0 && next < index; next += 1) {
          const text = (lines[next] as string).trim();
          if (/^\S+\.go:\d+:/.test(text)) {
            error = clip(text, 200);
            break;
          }
        }
      }
      found.push({ name, line: error });
    }
    return found;
  },
};

const RUNNERS: Runner[] = [vitest, jest, pytest, cargo, tap, goTest, mocha];

/** Reads counts, duration and failing tests from the output of one test command. */
export function parseTestOutput(output: string): ParsedTestRun {
  const lines = output.replace(ANSI, "").split(/\r?\n/).map((line) => line.replace(/\s+$/, ""));
  for (const runner of RUNNERS) {
    const counts = runner.counts(lines);
    const failures = runner.failures(lines);
    if (counts === null && failures.length === 0) continue;
    const unique = new Map<string, TestFailure>();
    for (const failure of failures) if (!unique.has(failure.name)) unique.set(failure.name, failure);
    const all = [...unique.values()];
    return {
      counts,
      durationMs: runner.duration(lines),
      failures: all.slice(0, MAX_FAILURES),
      moreFailures: Math.max(0, all.length - MAX_FAILURES),
    };
  }
  return { counts: null, durationMs: null, failures: [], moreFailures: 0 };
}
