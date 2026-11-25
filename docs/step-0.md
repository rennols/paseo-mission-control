# Step 0: setup run

Goal: settle the PRD's open questions on a real daemon before building features.
Checked against Paseo 0.17.4 (CLI, daemon, `@getpaseo/plugin`, `@getpaseo/client`), the public docs
in `getpaseo/paseo` at the `v0.17.4` tag (same as `main` on 2026-11-25 for the plugin pages), and a
dry run on a 0.17.4 daemon with the Claude provider.

## 1. Where the docs differ from the PRD

| # | Topic | PRD says | Paseo 0.17.4 says | Change needed |
|---|---|---|---|---|
| 1 | Hook registration | `server.addHook`, or `server.on` / `server.before` (unsure) | `server.addHook(name, asyncHandler)`. `on` / `before` still work but are deprecated, removed after 2027-04-30. `addHook` accepts only the new names. | Use `addHook` only. |
| 2 | Hook names | agent created, turn ended, permission requested, agent finished or archived | `agent.create.after`, `agent.turn.after`, `agent.permission.before`, `agent.archive.after`. There is no "agent finished" hook: use `agent.turn.after` and its `outcome`. | Rename in Technical design. |
| 3 | Hook count | "all eleven hooks" | 14 hooks (see the adapter's `HOOK_NAMES`). The `lifecycle-logger` example logs 13; it skips `worktree.create.before`. | Fix the count. |
| 4 | Turn-ended payload | Implied to carry the turn | `{ agent, turnId, outcome }` only. `timeline` is deprecated and always `[]`. Read the turn with `timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true })` and keep entries whose `turnId` matches. The list is empty if a newer turn already started. | Summary card and watchdog must handle an empty read. |
| 5 | SDK access in the server | `context.paseo` everywhere | The SDK is passed to hook, RPC and subscription handlers only, not to the entry function. One instance per subprocess (dry run: 1 instance across 50 events). The adapter keeps the first one it sees. | Watchdog timer, dispatcher loop and "rebuilt at start" can't call Paseo until the first hook or RPC. See open question 7. |
| 6 | Pause / stop | "Pause (stop the current run, keep the agent)"; unattended rule stops an agent | The plugin SDK has no cancel or stop. `paseo stop` (CLI) and the internal `DaemonClient.cancelAgent` exist, but plugins don't get them. `agents.ref(id).reload()` interrupts a running turn but also reopens the session. `archive()` closes the runtime. | Decide: use `reload()` as interrupt, drop Pause from v1, or ask Paseo for `cancel()`. |
| 7 | Commit and PR | "Uses Paseo's own commit and PR flow" | Not in the plugin SDK. The app uses internal `DaemonClient` calls (`checkoutCommit`, push, PR create) that plugins can't reach. | Review inbox runs `git` and `gh pr create` itself. |
| 8 | Cross-host | `context.paseo.hosts.client(id)` | Confirmed: returns a `PaseoApi` bound to that host, one hop only. Hooks never cross hosts. No API calls another host's plugin RPCs (`useRpc` and `server.handle` have no host parameter). | Per-host Needs you, queue and inbox. Option: mirror open Needs you items into agent `metadata`, which other hosts can read through the SDK. |
| 9 | `requirements.paseo` | `>=0.8.0` | `addHook` needs 0.14, `agent.background` 0.16, and `paseo plugin init` wrote `>=0.17.4`. | Set `>=0.17.4 <0.18.0` and widen per release. |
| 10 | Manifest | id, requirements | `id` (required), `name`, `description`, `icon` (PNG), `media`, `translations`, `requirements`, `build`. `name` needs 0.11+. Registry listing needs `OVERVIEW.md` and, for visual plugins, a screenshot in `media`. | Add `name: "Mission Control"`, an icon and a screenshot before publishing. |
| 11 | Plugin state | `$PASEO_HOME/control-room/state.json` | No documented data directory. Settings live in `$PASEO_HOME/plugin-settings/<id>/` and are deleted by `paseo plugin remove`. `PASEO_HOME` is often unset: the daemon defaults to `~/.paseo`. | Use `$PASEO_HOME/mission-control/state.json`, resolving the default ourselves (`server/paths.ts`). |
| 12 | Questions | "The agent ends its turn asking the user something" | Two kinds. A tool question (Claude's AskUserQuestion) arrives as `agent.permission.before` with `kind: "question"`, the question text and its options. A question in plain text has no signal; only the final assistant message. | Split the Question card: tool questions behave like permissions (answered by a click), text questions use the final-message rule. |
| 13 | Timeline rows | Summary row in the timeline, copy in state file | `timeline.append` rows are lost on daemon restart (in-memory). 64 KiB cap. Same `id` replaces. | Re-append summary rows from the state file after a restart, or accept the loss. |
| 14 | Error signature | "failing command plus first error line" | Shell calls are `tool_call` with `detail: { type: "shell", command, output?, exitCode? }`. With Claude, a failed command has `status: "failed"`, no `exitCode`, and a provider-specific `error` object (`{ type, content, is_error, tool_use_id }`). | Build the signature from `status` plus `error.content` or `output`, per provider. Check Codex shapes on the real run. |
| 15 | Background agents | Not mentioned | Helpers created with `background: true` are hidden from Paseo's lists; every hook payload carries `agent.background`. | Hide them from the tree and Needs you by default. |
| 16 | Hook order | Not specified | Archive fires `agent.archive.after` before `agent.close.after`. Worktree: `worktree.create.before` → `worktree.create.after` → `workspace.create.after` → `agent.create.before` → `agent.open.before` → `agent.create.after`. | None. |
| 17 | Install command | `paseo plugin add git:rennols/paseo-mission-control` | Valid. `git:owner/repo` and `github:owner/repo` both work; `--ref <branch>` picks a branch. | None. |

All other PRD API names exist in 0.17.4 with those names: `addScreen`, `defineRpc`, `defineSubscription`,
`addSidebarFooterItem`, `addSettingsScreen`, `registerSettings` (scopes `host` and `device`),
`timeline.append`, `addTimelineTransformer`, `addTimelineRenderer`, `addComposerPill`,
`addWorkspaceRowBadgeItem`, `addSlashCommand`, `defineAttachmentSource`, `addAttachmentSource`,
`addHeaderButton`. Pills can insert without sending through `PluginComposer.insertText`. Terminal
output for the attachment source is available through `terminals` (capture).

## 2. What the temporary logger records

`server/debug/hook-logger.ts` registers all 14 hooks through the adapter and writes one JSON line per
event to `$PASEO_HOME/mission-control/hook-log.jsonl` (default `~/.paseo/mission-control/hook-log.jsonl`)
and to the plugin log. Each line has the hook name, whether Paseo waits on it, the payload's shape and
a redacted copy. It also records three read-only probes:

- `probe.hosts`: the saved host list, once.
- `probe.pendingPermissions`: the same agent's `pendingPermissions` through the SDK, after each permission request.
- `probe.turn`: the item types and shapes of the turn that just ended, and the last 300 characters of the final message.

It never sends, approves or changes anything. Waiting hooks return the request unchanged. It touches
one file on disk. Prompts and file paths do appear in it, so read it before pasting.

## 3. Results so far (cloud dry run, Claude provider)

| Question | Answer | Evidence |
|---|---|---|
| Exact hook names | See rows 1 and 2 above. All events fired except worker and worktree hooks. | seq 2 to 53 |
| Do hooks see permission requests? | Yes. `agent.permission.before` carries the full request (`id`, `name`, `kind`, `input`, `detail`, `suggestions`). The SDK's `pendingPermissions` shows the same object, and `agent.permission.after` carries `{ requestId, resolution: { behavior } }`. | seq 17 to 19 |
| SDK commit, push, PR? | No. Use `git` and `gh`. | Types in `@getpaseo/client` 0.17.4 |
| Plugin state location | `$PASEO_HOME/mission-control/` works; no Paseo convention exists. | Daemon source, docs |
| Cross-host plugin RPC? | No. Read other hosts' agents with `hosts.client(serverId)`. | Docs, types. Needs the two-host run. |
| Question signal | Tool questions: yes (`kind: "question"`). Text questions: final message only. | seq 40, 47 |

Still open for the real run: worker nesting (`parentAgentId`), worktree hooks, a second host, and Codex payloads.

## 4. Run it on your daemon

Install (on each host you want to test, starting with the workstation):

```bash
paseo daemon status --json            # daemonVersion must be 0.17.x; note "home"
git clone https://github.com/rennols/paseo-mission-control.git ~/src/paseo-mission-control
cd ~/src/paseo-mission-control
git checkout claude/project-thread-j40m44
npm install && npm run typecheck
paseo plugin install "$PWD"           # needs Settings → Plugins → Enable plugins turned on
paseo plugin ls                       # mission-control: running, no error
paseo plugin logs mission-control     # shows "Logging 14 hooks to …/hook-log.jsonl"
```

Produce each event, one at a time, in a git project:

1. Start an agent: new agent in a new worktree workspace, prompt "Reply with OK." Expect the
   workspace, worktree and agent create hooks, `agent.open.before`, and a turn.
2. Launch a worker: in an agent's chat, "Use your Paseo tools to start one sub-agent that replies OK,
   then wait for it." Expect `agent.create.after` with `parentAgentId` set.
3. Permission request: agent in the default mode (not auto-accept or bypass), "Use the shell to run:
   touch mc-test.txt". Approve it in the app. Expect `agent.permission.before`,
   `probe.pendingPermissions`, `agent.permission.after`.
4. Turn ending with a question: (a) "Don't use tools. End your reply by asking me red or blue."
   (b) Claude only: "Use the AskUserQuestion tool to ask me src or docs." Answer it in the app.
5. Archive: archive one of the agents from the app. Expect `agent.archive.after`, then `agent.close.after`.
6. Optional: a failing command ("Run npm test in a folder with no package.json") and a Codex agent
   doing steps 1 and 3, for the watchdog signature.
7. Second host: install the same way on mac-mini, run step 1 there, and check the workstation's log
   does not get those hooks. `probe.hosts` on each host lists its saved hosts.

Collect: `cat ~/.paseo/mission-control/hook-log.jsonl` (or under your `PASEO_HOME`). Read it before
pasting: it contains prompts and paths. Turn it off afterwards with `paseo plugin disable mission-control`.
