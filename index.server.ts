import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DEFAULT_CHAT_SETTINGS, chatSettings, chatSettingsWatch, type ChatSettings } from "./shared/chat";
import { dismissNeed, extendTime, liveWatch, needsCountWatch, respondPermission, sendHint } from "./shared/live";
import { addTask, commitAndOpenPr, inboxWatch, moveTaskUp, queueWatch, removeTask, retryTask, sendBack, startTaskNow, workCountWatch } from "./shared/queue";
import {
  DEFAULT_QUEUE_SETTINGS,
  DEFAULT_WATCHDOG_SETTINGS,
  queueSettings,
  watchdogSettings,
  type QueueSettings,
  type WatchdogSettings,
} from "./shared/settings";
import { createInbox } from "./server/inbox/inbox";
import { createSummaryService } from "./server/chat/summary";
import { createFeed } from "./server/live/feed";
import { createHostsService } from "./server/live/hosts";
import { LOCAL, createRegistry } from "./server/live/registry";
import { log } from "./server/log";
import { createNeedsActions } from "./server/needs/actions";
import { createNeedsStore } from "./server/needs/needs";
import { createPaseoAdapter } from "./server/paseo/adapter";
import { createCatalog } from "./server/queue/catalog";
import { createTaskQueue } from "./server/queue/queue";
import { createWorkFeed } from "./server/queue/work-feed";
import { resolveStateDirectory } from "./server/paths";
import { openStateStore } from "./server/state/store";
import { createWatchdog } from "./server/watchdog/watchdog";

export default function contribute(server: PluginServerContext) {
  const paseo = createPaseoAdapter(server, log);
  const store = openStateStore(resolveStateDirectory(), log);
  const needs = createNeedsStore(store);
  const registry = createRegistry({
    hasOpen: (agentId, kind) => needs.openFor(agentId, kind).length > 0,
  });
  const hosts = createHostsService(registry, log, () => feed.changed());
  const feed = createFeed(registry, needs, hosts, log);

  // Settings: kept in memory, updated on save. Defaults until the first read finishes.
  let settings: WatchdogSettings = DEFAULT_WATCHDOG_SETTINGS;
  const settingsHandle = paseo.registerSettings(watchdogSettings);
  void settingsHandle
    .read()
    .then((state) => {
      if (state.status === "ready") settings = state.values;
      else log.warn("settings", "Watchdog settings are invalid; using defaults", state.error);
    })
    .catch((error: unknown) => log.error("settings", "Could not read watchdog settings", error));
  const stopSettings = settingsHandle.subscribe((next) => {
    if (next.status === "ready") {
      settings = next.values;
      log.info("settings", "Watchdog settings changed", settings);
    }
  });

  // Queue settings: same pattern as the watchdog's.
  let queueLimits: QueueSettings = DEFAULT_QUEUE_SETTINGS;
  const queueSettingsHandle = paseo.registerSettings(queueSettings);
  void queueSettingsHandle
    .read()
    .then((state) => {
      if (state.status === "ready") queueLimits = state.values;
      else log.warn("settings", "Queue settings are invalid; using defaults", state.error);
    })
    .catch((error: unknown) => log.error("settings", "Could not read queue settings", error));
  const stopQueueSettings = queueSettingsHandle.subscribe((next) => {
    if (next.status === "ready") {
      queueLimits = next.values;
      log.info("settings", "Queue settings changed", queueLimits);
      work.changed();
      registry.refresh();
    }
  });
  // Chat settings: summary card and quick replies. Pushed to every client that registers pills.
  let chat: ChatSettings = DEFAULT_CHAT_SETTINGS;
  const chatListeners = new Set<(next: ChatSettings) => void>();
  const chatHandle = paseo.registerSettings(chatSettings);
  void chatHandle
    .read()
    .then((state) => {
      if (state.status === "ready") {
        chat = state.values;
        for (const listener of chatListeners) listener(chat);
      } else log.warn("settings", "Chat settings are invalid; using defaults", state.error);
    })
    .catch((error: unknown) => log.error("settings", "Could not read chat settings", error));
  const stopChatSettings = chatHandle.subscribe((next) => {
    if (next.status !== "ready") return;
    chat = next.values;
    log.info("settings", "Chat settings changed", { summaryCard: chat.summaryCard, quickReplies: chat.quickReplies, replies: chat.replies.length });
    for (const listener of chatListeners) listener(chat);
  });
  const summaries = createSummaryService(paseo, store, () => chat, resolveStateDirectory(), log);

  const watchdog = createWatchdog(paseo, registry, needs, store, () => settings, log);
  const actions = createNeedsActions(
    needs,
    store,
    (agentId) => watchdog.resetCounters(agentId),
    (agentId) => registry.get(LOCAL, agentId)?.title ?? "The agent",
    log,
  );

  const catalog = createCatalog();
  const queue = createTaskQueue(paseo, registry, store, catalog, () => queueLimits, log, (agentId, resolution) => {
    const open = needs.openFor(agentId).filter((item) => item.kind === "permission" || item.kind === "question");
    const count = open.reduce((sum, item) => sum + Math.max(1, item.requests.length), 0);
    if (open.length > 0) needs.resolveFor(agentId, ["permission", "question"], resolution);
    return count;
  });
  const inbox = createInbox(paseo, registry, store, { taskForAgent: (agentId) => queue.taskForAgent(agentId) }, log);
  const work = createWorkFeed(queue, inbox, () => hosts.self().label, log);
  const offRegistryWork = registry.onChange(() => work.changed());

  // The SDK arrives with the first hook, RPC or subscription (Paseo 0.17.4 doesn't give it to the
  // entry function). Everything that needs it starts then.
  paseo.onPaseo("startup", (api) => {
    hosts.start(api);
    watchdog.start(api);
    queue.start(api);
    log.info("startup", "Mission Control running", { stateDirectory: resolveStateDirectory() });
  });

  paseo.handle(liveWatch, (_input, { paseo: api, push, signal }) => {
    paseo.capture(api);
    hosts.includeRemote();
    const remove = feed.addLive(push);
    signal.addEventListener("abort", remove, { once: true });
  });
  paseo.handle(needsCountWatch, (_input, { paseo: api, push, signal }) => {
    paseo.capture(api);
    const remove = feed.addCount(push);
    signal.addEventListener("abort", remove, { once: true });
  });
  paseo.handle(chatSettingsWatch, (_input, { paseo: api, push, signal }) => {
    paseo.capture(api);
    const send = (next: ChatSettings) => push({ quickReplies: next.quickReplies, replies: next.replies });
    send(chat);
    chatListeners.add(send);
    signal.addEventListener("abort", () => chatListeners.delete(send), { once: true });
  });
  paseo.handle(respondPermission, async (input, { paseo: api }) => {
    paseo.capture(api);
    return actions.respondPermission(api, input);
  });
  paseo.handle(sendHint, async (input, { paseo: api }) => {
    paseo.capture(api);
    return actions.sendHint(api, input);
  });
  paseo.handle(dismissNeed, async (input, { paseo: api }) => {
    paseo.capture(api);
    return actions.dismiss(input);
  });
  paseo.handle(extendTime, async (input, { paseo: api }) => {
    paseo.capture(api);
    return actions.extendTime(input);
  });

  paseo.handle(queueWatch, (_input, { paseo: api, push, signal }) => {
    paseo.capture(api);
    void queue.refreshCatalog(api).catch((error: unknown) => log.warn("queue", "Could not read projects and profiles", error instanceof Error ? error.message : String(error)));
    const remove = work.addQueue(push);
    signal.addEventListener("abort", remove, { once: true });
  });
  paseo.handle(inboxWatch, (_input, { paseo: api, push, signal }) => {
    paseo.capture(api);
    void inbox.recheck().catch((error: unknown) => log.error("inbox", "Re-check failed", error));
    const remove = work.addInbox(push);
    signal.addEventListener("abort", remove, { once: true });
  });
  paseo.handle(workCountWatch, (_input, { paseo: api, push, signal }) => {
    paseo.capture(api);
    const remove = work.addCounts(push);
    signal.addEventListener("abort", remove, { once: true });
  });
  paseo.handle(addTask, async (input, { paseo: api }) => {
    paseo.capture(api);
    return queue.add(api, input);
  });
  paseo.handle(removeTask, async (input, { paseo: api }) => {
    paseo.capture(api);
    return queue.remove(input.taskId);
  });
  paseo.handle(moveTaskUp, async (input, { paseo: api }) => {
    paseo.capture(api);
    return queue.moveUp(input.taskId);
  });
  paseo.handle(startTaskNow, async (input, { paseo: api }) => {
    paseo.capture(api);
    return queue.startNow(api, input.taskId);
  });
  paseo.handle(retryTask, async (input, { paseo: api }) => {
    paseo.capture(api);
    return queue.retry(input.taskId);
  });
  paseo.handle(commitAndOpenPr, async (input, { paseo: api }) => {
    paseo.capture(api);
    return inbox.openPr(input);
  });
  paseo.handle(sendBack, async (input, { paseo: api }) => {
    paseo.capture(api);
    return inbox.sendBack(api, input);
  });

  return async () => {
    queue.stop();
    inbox.stop();
    work.stop();
    offRegistryWork();
    stopQueueSettings();
    watchdog.stop();
    summaries.stop();
    stopSettings();
    stopChatSettings();
    chatListeners.clear();
    feed.stop();
    await hosts.stop();
    await store.flush();
  };
}
