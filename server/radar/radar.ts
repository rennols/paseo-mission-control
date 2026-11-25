/**
 * Collision radar (PRD: Collision radar). Warns in Needs you when two agents on this host edit the
 * same lines of a file in different worktrees of one repo, before their branches meet in a merge.
 *
 * How it works, with nothing the agents didn't already do:
 * - The turn summary snapshots each agent's worktree as a git tree at the start and end of every
 *   turn (../chat/snapshot.ts). The radar keeps, per agent, the tree from the start of its first
 *   turn Mission Control saw (where its work began) and the tree from its latest turn.
 * - After a turn's summary is stored, it compares that agent with every other agent whose
 *   worktree shares the same git repository: the files both changed, then the changed line ranges
 *   of each shared file, measured from the first agent's starting version (`git diff -U0`).
 * - Ranges that overlap or touch (what git reports as a conflict) open one card per agent pair.
 *   The card closes by itself when a later turn shows the overlap is gone, or when either agent is
 *   archived. Settings can widen it to any shared file, or turn it off.
 *
 * It only flags. It never pauses, stops, sends or merges anything. Read-only git only (./git.ts).
 * Hooks don't cross hosts, so agents on other hosts are not compared.
 */
import type { TurnSummary } from "../../shared/chat";
import type { WatchdogSettings } from "../../shared/settings";
import type { PluginLogger } from "../log";
import type { NeedsStore } from "../needs/needs";
import type { PaseoAdapter } from "../paseo/adapter";
import { LOCAL, type Registry } from "../live/registry";
import type { RadarAgent, StateStore } from "../state/store";
import { blobsIn, changedPaths, commonDirOf, hunksBetween } from "./git";
import {
  classifyFile,
  describeCollision,
  overlaps,
  pairKey,
  reachesNewFile,
  signature,
  type FileCollision,
} from "./model";

const FEATURE = "radar";
/** Shared files compared per pair; the rest only count toward "+N more files". */
const MAX_FILES_COMPARED = 40;
/** Agents with no turn for this long are forgotten (git may have pruned their snapshots). */
const FORGET_AFTER_MS = 14 * 24 * 60 * 60_000;

export type RadarMode = WatchdogSettings["collisionRadar"];

export interface Radar {
  /** After a turn summary is stored. `root` is the worktree it was taken in. */
  noteTurn(summary: TurnSummary, root: string | null): void;
  /** The user dismissed a collision card: stay quiet until the overlap reaches a new file. */
  dismissed(key: string): void;
  /** Settings changed. */
  modeChanged(mode: RadarMode): void;
  /** Runs queued checks to the end. For tests and shutdown. */
  idle(): Promise<void>;
  stop(): void;
}

export function createRadar(
  adapter: PaseoAdapter,
  registry: Registry,
  needs: NeedsStore,
  store: StateStore,
  mode: () => RadarMode,
  log: PluginLogger,
  now: () => number = Date.now,
): Radar {
  /** Checks run one at a time, in turn order. */
  let chain: Promise<void> = Promise.resolve();
  const state = () => store.state.radar;
  /** Last signature per open pair (persisted), so a dismissal remembers what the card listed. */
  const shown = {
    get: (key: string): string | undefined => state().shown[key],
    set(key: string, sig: string): void {
      if (state().shown[key] === sig) return;
      state().shown[key] = sig;
      store.changed();
    },
    delete(key: string): void {
      if (!(key in state().shown)) return;
      delete state().shown[key];
      store.changed();
    },
    clear(): void {
      state().shown = {};
      store.changed();
    },
  };

  function enqueue(label: string, work: () => Promise<void>): void {
    chain = chain.then(work).catch((error: unknown) => log.error(FEATURE, `${label} failed`, error));
  }

  function agentInfo(agentId: string): { title: string; branch: string | null } {
    const entry = registry.get(LOCAL, agentId);
    return { title: entry?.title ?? "another agent", branch: entry?.branch ?? null };
  }

  function live(agentId: string): boolean {
    const entry = registry.get(LOCAL, agentId);
    return !!entry && !entry.background && entry.lifecycle !== "closed";
  }

  function prune(at: number): void {
    let any = false;
    for (const [agentId, agent] of Object.entries(state().agents)) {
      if (at - agent.updatedAt > FORGET_AFTER_MS) {
        delete state().agents[agentId];
        any = true;
      }
    }
    if (any) store.changed();
  }

  async function compare(a: RadarAgent, b: RadarAgent, current: RadarMode): Promise<{ files: FileCollision[]; more: number }> {
    const [pathsA, pathsB] = await Promise.all([
      changedPaths(a.root, a.baseTree, a.headTree),
      changedPaths(a.root, b.baseTree, b.headTree),
    ]);
    const inB = new Set(pathsB);
    const shared = pathsA.filter((file) => inB.has(file)).sort();
    if (shared.length === 0) return { files: [], more: 0 };
    const checked = shared.slice(0, MAX_FILES_COMPARED);
    const [baseA, headA, baseB, headB] = await Promise.all(
      [a.baseTree, a.headTree, b.baseTree, b.headTree].map((tree) => blobsIn(a.root, tree, checked)),
    );
    const files: FileCollision[] = [];
    for (const file of checked) {
      const blobs = { baseA: baseA!.get(file), headA: headA!.get(file), baseB: baseB!.get(file), headB: headB!.get(file) };
      const verdict = classifyFile(blobs);
      if (verdict.kind === "skip") continue;
      if (verdict.kind === "structural") {
        files.push({ path: file, level: "lines", overlaps: [], reason: verdict.reason });
        continue;
      }
      // Both measured from A's starting version. When B started from a different version, B's
      // ranges also include what changed between the two starts, so this can over-report.
      const [hunksA, hunksB] = await Promise.all([
        hunksBetween(a.root, blobs.baseA!, blobs.headA!),
        hunksBetween(a.root, blobs.baseA!, blobs.headB!),
      ]);
      const found = overlaps(hunksA, hunksB);
      files.push({ path: file, level: found.length > 0 ? "lines" : "file", overlaps: found, reason: null });
    }
    const kept = current === "files" ? files : files.filter((file) => file.level === "lines");
    return { files: kept, more: kept.length > 0 ? shared.length - checked.length : 0 };
  }

  function close(key: string, resolution: string): void {
    const open = needs.openKeyed(key);
    if (open) needs.resolve(open.id, resolution);
    shown.delete(key);
  }

  async function check(agentId: string): Promise<void> {
    const current = mode();
    if (current === "off") return;
    const self = state().agents[agentId];
    if (!self) return;
    for (const [otherId, other] of Object.entries(state().agents)) {
      if (otherId === agentId || other.commonDir !== self.commonDir || other.root === self.root) continue;
      const key = pairKey(agentId, otherId);
      if (!live(otherId)) continue;
      let result: { files: FileCollision[]; more: number };
      try {
        result = await compare(self, other, current);
      } catch (error) {
        log.warn(FEATURE, "Could not compare two agents; skipping this pair", {
          agents: [agentId, otherId],
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (result.files.length === 0) {
        close(key, `No longer overlapping ${agentInfo(otherId).title}.`);
        if (state().dismissed[key]) {
          delete state().dismissed[key];
          store.changed();
        }
        continue;
      }
      const sig = signature(result.files);
      const dismissedSig = state().dismissed[key];
      if (dismissedSig !== undefined) {
        if (!reachesNewFile(dismissedSig, sig)) continue;
        delete state().dismissed[key];
        store.changed();
      }
      const { title, detail } = describeCollision(agentInfo(otherId), result.files);
      const fullDetail = result.more > 0 ? `${detail}\n+${result.more} more shared files not compared` : detail;
      const card = needs.raiseKeyed(key, agentId, agentInfo(agentId).title, [otherId], title, fullDetail);
      if (shown.get(key) !== sig) {
        log.info(FEATURE, "Collision", { agents: [agentId, otherId], card: card.id, files: result.files.map((file) => `${file.level}: ${file.path}`) });
      }
      shown.set(key, sig);
    }
  }

  async function note(summary: TurnSummary, root: string): Promise<void> {
    if (!summary.trees) return;
    const at = now();
    prune(at);
    const previous = state().agents[summary.agentId];
    let record: RadarAgent;
    if (previous && previous.root === root) {
      record = { ...previous, headTree: summary.trees.after, updatedAt: at };
    } else {
      const commonDir = await commonDirOf(root);
      if (!commonDir) return;
      record = { root, commonDir, baseTree: summary.trees.before, headTree: summary.trees.after, updatedAt: at };
    }
    const changedTree = !previous || previous.headTree !== record.headTree || previous.root !== record.root;
    state().agents[summary.agentId] = record;
    store.changed();
    if (changedTree) await check(summary.agentId);
  }

  function forget(agentId: string, why: string): void {
    if (state().agents[agentId]) {
      delete state().agents[agentId];
      store.changed();
    }
    for (const item of needs.openInvolving(agentId, "collision")) {
      needs.resolve(item.id, why);
      if (item.key) shown.delete(item.key);
    }
    for (const key of Object.keys(state().dismissed)) {
      if (key.split(/[:|]/).includes(agentId)) {
        delete state().dismissed[key];
        store.changed();
      }
    }
  }

  const removers = [
    adapter.addHook("agent.archive.after", FEATURE, async ({ agent }) => {
      const title = registry.get(LOCAL, agent.id)?.title ?? agent.title ?? "An agent";
      forget(agent.id, `${title} was archived.`);
    }),
  ];

  return {
    noteTurn(summary, root) {
      if (!root || !summary.trees || mode() === "off") return;
      enqueue("Collision check", () => note(summary, root));
    },
    dismissed(key) {
      const sig = shown.get(key);
      if (sig === undefined) return;
      state().dismissed[key] = sig;
      shown.delete(key);
      store.changed();
      log.info(FEATURE, "Collision dismissed by the user", { key });
    },
    modeChanged(next) {
      if (next !== "off") return;
      for (const item of needs.list().filter((entry) => entry.kind === "collision" && entry.resolvedAt === null)) {
        needs.resolve(item.id, "Collision radar turned off.");
      }
      shown.clear();
    },
    idle: () => chain,
    stop() {
      for (const remove of removers) remove();
    },
  };
}
