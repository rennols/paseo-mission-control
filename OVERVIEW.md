Mission Control helps one person supervise many coding agents running in parallel across several Paseo hosts. It turns them into one short list of decisions.

The Mission Control screen, opened from the sidebar footer, shows every agent on this host and on the hosts saved in it, grouped by workspace, with workers nested under the agent that started them. Each row has a status, a 30-minute activity lane, lines changed and the latest activity. Beside it, Needs you lists what is waiting on you on this host: permission requests (Allow once or Deny), questions the agent asked, agents that look stuck, and runs past their time limit. The sidebar entry shows how many items are open.

The watchdog checks every finished turn. It flags an agent that hits the same error 3 turns in a row, changes no files for 5 turns you started, or runs longer than 45 minutes. It only flags: it never pauses, stops, answers or sends anything on its own. Change the thresholds under Settings, Plugins, Mission Control.

What it reads and writes: it reads agent timelines through Paseo, runs read-only `git status` and `git diff --numstat` in agent working folders to tell whether a turn changed files, and keeps its own state in `~/.paseo/mission-control/state.json` (under `PASEO_HOME` if set). It talks only to Paseo hosts saved in this daemon.

Install it on every host you want supervised: each host's lifecycle events reach only the copy running on that host, so Needs you and the watchdog are per host, and agents on other hosts are shown read-only. Requires Paseo 0.17.4 or a later 0.17 release.
