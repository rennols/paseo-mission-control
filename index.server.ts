import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DEFAULT_CHAT_SETTINGS, chatSettings, chatSettingsWatch, type ChatSettings } from "./shared/chat";
import { dismissNeed, extendTime, liveWatch, needsCountWatch, respondPermission, sendHint } from "./shared/live";
import { DEFAULT_WATCHDOG_SETTINGS, watchdogSettings, type WatchdogSettings } from "./shared/settings";
import { createSummaryService } from "./server/chat/summary";
import { createFeed } from "./server/live/feed";
import { createHostsService } from "./server/live/hosts";
import { LOCAL, createRegistry } from "./server/live/registry";
import { log } from "./server/log";
import { createNeedsActions } from "./server/needs/actions";
import { createNeedsStore } from "./server/needs/needs";
import { createPaseoAdapter } from "./server/paseo/adapter";
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

  // The SDK arrives with the first hook, RPC or subscription (Paseo 0.17.4 doesn't give it to the
  // entry function). Everything that needs it starts then.
  paseo.onPaseo("startup", (api) => {
    hosts.start(api);
    watchdog.start(api);
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

  return async () => {
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
