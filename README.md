# Mission Control

A Paseo plugin for supervising many coding agents in parallel across hosts. Plugin id `mission-control`.

Status: P0 in progress. Built: Live tab, Needs you, watchdog, sidebar footer entry, settings screen,
turn summary card and quick reply pills. P1: task queue, review inbox, saved prompts (`/p`),
branch row badges, and test and edit cards.

Compact explore rows are not built as a plugin feature: Paseo 0.17.4 already folds runs of tool calls
into one expandable row (Settings → Chat → Chat display: "Collapse tool calls" or "Collapse turns").
A plugin timeline transformer sees one call at a time, so it could not fold a run, and replacing calls
with plugin rows would break Paseo's own folding.

## Layout

| Path | Runs in | Purpose |
| --- | --- | --- |
| `index.server.ts` | Daemon subprocess | Server entry. Owns all state and logic. |
| `server/paseo/adapter.ts` | Daemon subprocess | The one module that calls Paseo: hooks, settings, RPC handlers, SDK. |
| `server/log.ts` | Daemon subprocess | Plugin log (`paseo plugin logs mission-control`). |
| `server/paths.ts` | Daemon subprocess | Resolves `$PASEO_HOME/mission-control/` for state. |
| `server/watchdog/` | Daemon subprocess | Turn analysis, counting rules, read-only git check, hook wiring. |
| `server/needs/` | Daemon subprocess | Needs you items and the card actions (RPC handlers). |
| `server/live/` | Daemon subprocess | Agent registry, lanes, host directories, the snapshot feed. |
| `server/queue/` | Daemon subprocess | Task queue, slot rules, dispatcher, unattended stop, Add task catalog. |
| `server/inbox/` | Daemon subprocess | Review inbox: read-only git review, commit/push/`gh pr create` on click. |
| `server/chat/` | Daemon subprocess | Turn summaries: git snapshots per turn, checks read from the agent's own commands. |
| `server/state/store.ts` | Daemon subprocess | `$PASEO_HOME/mission-control/state.json`, temp file then rename. |
| `test/` | Node (vitest) | Unit tests for the pure parts. Not shipped. |
| `scripts/verify-summaries.mjs` | Your shell | Phase gate 2: runs 20 real turns in a scratch repo and compares each summary with git. Not shipped. |
| `index.client.tsx`, `client/` | Paseo app | Renders and calls RPCs only. |
| `shared/` | Both | `defineRpc` / `defineSubscription` contracts and plain values. |

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"        # first time, from this folder
paseo plugin reload mission-control  # after each change
paseo plugin logs mission-control
```

Built against Paseo 0.17.4 (`requirements.paseo` is `>=0.17.4 <0.18.0`). Check each new Paseo release before widening the range.

## Chat features

**Turn summary card.** On `agent.turn.before` the server snapshots the agent's worktree with
`git add -A` into a temporary index and `git write-tree`; on `agent.turn.after` it snapshots again and
lists `git diff --numstat` between the two trees. So the list is exactly what changed in the turn,
including untracked files and commits the agent made, and excluding files `.gitignore` leaves out.
The repo's own index and branches are never changed. `git add` does write loose objects into
`.git/objects`; nothing references them and `git gc` removes them later. Checks are the agent's own
shell calls that start with a pattern from Settings → Chat; the plugin never runs one.

Known limits on Paseo 0.17.4: cards appended with `timeline.append` are dropped when the daemon
restarts (re-appending would put them at the end and stretch Paseo's "Worked for" time, so they are
not restored; the copy stays in `state.json`). Timeline renderers cannot open Paseo's Changes panel,
so the card has no View changes button. Quick replies are per host, not per device, because the client
entry cannot read device settings.

**Quick reply pills.** One pill per reply above every agent's composer. A pill inserts its text and
focuses the composer; it never sends. Edit the list in Settings → Plugins → Mission Control → Chat.

**Saved prompts.** A Prompts pill above every agent's composer opens a menu of saved prompts, and
`/p <name>` in the composer does the same (`/p rev` works when only one name starts with it). Both fill
`{branch}`, `{workspace}` and `{agent}` and put the prompt in the composer; neither sends it. Paseo
clears `/p …` from the composer before the plugin runs, so an unknown name shows a toast and leaves
the composer empty. Defaults: review, tdd, bugfix, docs. Edit them in Settings → Plugins → Mission
Control → Chat, one prompt per `/name` line followed by its text. Per host, like quick replies.

**Test and edit cards.** A client timeline transformer replaces a finished shell call that runs a
check command (the Check commands patterns) with a test card: the command, a Passed or Failed pill,
counts and duration, and only the failing tests with their first error line, with Show full output
(the last 32,000 characters). It reads vitest, jest, pytest, go test, cargo test, node:test (TAP and
spec) and mocha's counts (`shared/test-output.ts`). A finished Edit or Write becomes an edit card: the
path relative to the agent's folder, lines added and removed, and the first 6 diff lines with Show all
lines. The diff comes from the edit tool's own unified diff or old and new strings; the plugin never
reads the file or runs a check. Output it can't read, running calls and failed edits keep Paseo's
own row. The cards are built on render, so unlike the turn summary card they survive a daemon
restart. With Paseo's Chat display set to "Collapse turns", a folded turn's line ("Read 2 files")
doesn't count calls that became cards, and a turn whose only calls became cards doesn't fold; turn
either card off under Settings → Plugins → Mission Control → Chat if you prefer Paseo's fold counts.
A settings change applies to rows rendered after it; reopen a chat to redo the rows already shown.

**Branch row badges.** A workspace row in Paseo's sidebar gets a short badge while an agent in it has
an open Needs you card: approve, question, stuck or over 45m (the watchdog's time limit), with a count
when several agents share one. Rows with nothing open get no badge. Hide them from the sidebar's Show
menu ("Mission Control: Needs you"). Badges cover this host only, like Needs you.
