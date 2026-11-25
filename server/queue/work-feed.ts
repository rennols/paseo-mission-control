/**
 * Pushes Queue and Review inbox snapshots, and their counts, to open screens. Changes are
 * coalesced (at most one push per 250 ms). The client never polls.
 */
import type { InboxSnapshot, QueueSnapshot } from "../../shared/queue";
import type { Inbox } from "../inbox/inbox";
import type { PluginLogger } from "../log";
import type { TaskQueue } from "./queue";

const FEATURE = "queue";
const COALESCE_MS = 250;

type Push<T> = (event: T) => Promise<void>;
type Counts = { queued: number; review: number };

export interface WorkFeed {
  addQueue(push: Push<QueueSnapshot>): () => void;
  addInbox(push: Push<InboxSnapshot>): () => void;
  addCounts(push: Push<Counts>): () => void;
  changed(): void;
  stop(): void;
}

export function createWorkFeed(queue: TaskQueue, inbox: Inbox, hostLabel: () => string, log: PluginLogger): WorkFeed {
  const queues = new Set<Push<QueueSnapshot>>();
  const inboxes = new Set<Push<InboxSnapshot>>();
  const counts = new Set<Push<Counts>>();
  let pending: NodeJS.Timeout | null = null;
  let lastCounts = "";

  function send<T>(targets: Set<Push<T>>, event: T): void {
    for (const push of targets) {
      push(event).catch((error: unknown) => log.warn(FEATURE, "Push failed", error instanceof Error ? error.message : String(error)));
    }
  }

  function currentCounts(): Counts {
    return { queued: queue.queuedCount(), review: inbox.openCount() };
  }

  function flush(): void {
    pending = null;
    try {
      if (queues.size > 0) send(queues, queue.snapshot(hostLabel()));
      if (inboxes.size > 0) send(inboxes, inbox.snapshot(hostLabel()));
      const next = currentCounts();
      const key = `${next.queued}:${next.review}`;
      if (counts.size > 0 && key !== lastCounts) send(counts, next);
      lastCounts = key;
    } catch (error) {
      log.error(FEATURE, "Could not build the Queue or Review inbox snapshot", error);
    }
  }

  function changed(): void {
    if (pending) return;
    pending = setTimeout(flush, COALESCE_MS);
  }

  const offQueue = queue.onChange(changed);
  const offInbox = inbox.onChange(changed);

  function add<T>(targets: Set<Push<T>>, push: Push<T>, first: () => T): () => void {
    targets.add(push);
    try {
      push(first()).catch(() => undefined);
    } catch (error) {
      log.error(FEATURE, "Could not build the first snapshot", error);
    }
    return () => targets.delete(push);
  }

  return {
    addQueue: (push) => add(queues, push, () => queue.snapshot(hostLabel())),
    addInbox: (push) => add(inboxes, push, () => inbox.snapshot(hostLabel())),
    addCounts: (push) => add(counts, push, currentCounts),
    changed,
    stop() {
      offQueue();
      offInbox();
      if (pending) clearTimeout(pending);
      queues.clear();
      inboxes.clear();
      counts.clear();
    },
  };
}
