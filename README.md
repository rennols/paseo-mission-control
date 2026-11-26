# Mission Control

A Paseo plugin for supervising many coding agents in parallel across hosts. Plugin id `mission-control`.

Status: P0 in progress. Built: Live tab, Needs you, watchdog, sidebar footer entry, settings screen,
turn summary card and quick reply pills. P1: task queue, review inbox, saved prompts (`/p`),
branch row badges, and test and edit cards. Added outside the PRD's first list: collision radar and
the Office tab.

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
| `server/report/` | Daemon subprocess | Overnight report: window and per-run rules, built from stored state only. |
| `server/inbox/` | Daemon subprocess | Review inbox: read-only git review, commit/push/`gh pr create` on click. |
| `server/office/` | Daemon subprocess | Office tab: follows working agents' live timelines for the now line and in-agent subagents. |
| `server/radar/` | Daemon subprocess | Collision radar: compares agents' turn snapshots per repo, read-only git. |
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
an open Needs you card: approve, question, stuck, over 45m (the watchdog's time limit) or overlap, with a count
when several agents share one. Rows with nothing open get no badge. Hide them from the sidebar's Show
menu ("Mission Control: Needs you"). Badges cover this host only, like Needs you.

## Office tab

A visual view of who is working on what. Each top-level agent is a **supervisor** with a room. The
agents it hands work to sit at **desks** in that room: Paseo subagents (agents started by another
agent, at any depth) and in-agent subagents the provider runs inside it (Claude's Task tool, tagged
"In-agent · Explore" and named by their task). Each desk shows what it was asked, what it is doing right now ("Read part5.ts",
"Running npm test"), and its state as an icon, a word and a pose: Working, Waiting on you, Stuck,
Done. A new handoff slides a desk in and puts a "Handed to …" slip on the supervisor's desk for a
minute. With the system's reduced motion setting on, nothing moves. Finished desks fold into
"N finished" after 10 minutes. A head count at the top shows how many are waiting on you, stuck,
working and done. Rooms where nobody is working or waiting fold into one line each under "Quiet
rooms"; tap one to unfold it. Tapping a desk opens that agent's chat (an in-agent subagent opens its
supervisor's). Approvals stay in Needs you on the Live tab: a waiting desk has an "Answer in Needs
you" button that switches to it. On a phone, desks stack one per row and the head count shows only
the states someone is in.

How: the server follows the live timeline of each working agent on this host
(`agents.ref(id).timeline.subscribe`, one feed per working agent, released a minute after it goes
idle; on start and after a reconnect it reads the current turn with `timeline.refetch` to catch up;
an agent that was already idle when the plugin started has its last turn read once, so its finished
helpers stay in the room) and adds the now line and in-agent subagents to the Live snapshot. The client renders that
snapshot; it never polls.

Limits (Paseo 0.17.4): an in-agent subagent shows its task and state but not its own step-by-step
actions, because Paseo sends those on a separate channel plugins can't read. Agents on other hosts
get rooms and desks from their directory, but their now line only updates when a turn ends.

## Collision radar

Needs you shows a **Collision** card when two agents on this host, in different worktrees of the same
repo, have edited the same or adjacent lines of a file: what git would report as a merge conflict.
The card names the other agent and its branch, and lists the files with line ranges and, when git
finds one, the enclosing function ("app.js lines 4–5 in function greet(name)"). Both agents'
workspace rows get an "overlap" badge. The card closes by itself when a later turn shows the overlap
is gone, or when either agent is archived. Send a hint sends your text as that agent's next prompt;
Dismiss keeps the pair quiet until the overlap reaches a file the card didn't list. It never pauses,
stops, merges or sends anything on its own.

How: the turn summary already snapshots each worktree as a git tree before and after every turn. The
radar keeps each agent's tree from the start of the first turn Mission Control saw and its latest
tree, and after each turn compares that agent with the others whose worktrees share the repo's git
directory, using read-only `git diff --name-only`, `git ls-tree` and `git diff -U0` on those stored
trees. It runs even with the summary card turned off (only the card is hidden).

Settings → Plugins → Mission Control → Watchdog → Collision radar: **Same lines** (default), **Same
file** (any file both changed), or **Off**.

Limits: this host only (hooks don't cross hosts, so an agent on another host is never compared).
Edits made before Mission Control saw an agent's first turn are not counted. When two agents started
from different versions of a file, ranges are measured from the first agent's version, so the radar
can over-report. If one agent merges the other's branch into its own and keeps editing, the merged
lines can show as an overlap until the other agent is archived.

## Overnight report

A card at the top of the Queue tab lists the queue runs of the overnight window (Settings, Queue;
default 22:00 to 07:00 in the host's local time). In the morning it shows last night; during the
night it shows tonight so far. Each run has its outcome line, what changed, the last result of each
check the agent ran itself, and what it needs from you: an open permission, question, stuck or over
time card, its Review inbox item, or a look at a failed or stopped run. Runs that need you come
first. Review switches to the Review inbox; Open chat opens the agent.

It is built from what Mission Control already stores (queue tasks, Review inbox items, Needs you
cards and turn summaries); it runs no commands. "What changed" is the branch against its base when
the run is in the Review inbox, otherwise the run's turn summaries (turns with no changes are stored
too, with no card, so "No file changes" comes from git). Finished runs stay in the report for 24 h,
or until you clear them from the queue list. Run start and end times show in the viewing device's
clock; the window label is the host's.
