Mission Control helps one person supervise many coding agents running in parallel across several Paseo hosts. It turns them into one short list of decisions: a live agent tree, a Needs you list for permission requests, questions and stuck agents, and a watchdog that flags agents looping on the same error.

This plugin is in early development. The current version only logs Paseo lifecycle events to `~/.paseo/mission-control/hook-log.jsonl` and to the plugin log. It does not change, approve or send anything.

Install it on every host you want to supervise, because each host's lifecycle events reach only the copy running on that host. Requires Paseo 0.17.4 or a later 0.17 release.
